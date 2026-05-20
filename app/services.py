import hashlib
import re
import shutil
import subprocess
from pathlib import Path

import httpx
from sqlalchemy.orm import Session

from .database import REPO_DIR
from .models import AIModel, CodeChunk, GitRepo


TEXT_EXTENSIONS = {
    ".java", ".kt", ".py", ".js", ".jsx", ".ts", ".tsx", ".vue", ".go", ".rs",
    ".cs", ".cpp", ".c", ".h", ".hpp", ".php", ".rb", ".sql", ".xml", ".yaml",
    ".yml", ".json", ".properties", ".gradle", ".md", ".txt", ".sh", ".bat",
}


def safe_repo_dir(repo: GitRepo) -> Path:
    digest = hashlib.sha1(f"{repo.id}:{repo.git_url}".encode("utf-8")).hexdigest()[:12]
    return REPO_DIR / f"repo_{repo.id}_{digest}"


def sync_repo(db: Session, repo: GitRepo, access_token: str = "") -> dict:
    target = safe_repo_dir(repo)
    if not repo.git_url:
        raise ValueError("GitLab 地址不能为空")

    url = repo.git_url
    token = access_token or repo.access_token
    if token and url.startswith("https://") and "@" not in url.split("//", 1)[1].split("/", 1)[0]:
        url = url.replace("https://", f"https://oauth2:{token}@", 1)

    if target.exists() and (target / ".git").exists():
        subprocess.run(["git", "-C", str(target), "fetch", "--all", "--prune"], check=True, capture_output=True, text=True)
        subprocess.run(["git", "-C", str(target), "checkout", repo.branch], check=True, capture_output=True, text=True)
        subprocess.run(["git", "-C", str(target), "pull"], check=True, capture_output=True, text=True)
    else:
        if target.exists():
            shutil.rmtree(target)
        subprocess.run(["git", "clone", "--branch", repo.branch, "--depth", "1", url, str(target)], check=True, capture_output=True, text=True)

    repo.local_path = str(target)
    db.query(CodeChunk).filter(CodeChunk.repo_id == repo.id).delete()
    indexed = index_repo(db, repo, target)
    return {"local_path": str(target), "indexed_chunks": indexed}


def index_repo(db: Session, repo: GitRepo, root: Path) -> int:
    count = 0
    for path in root.rglob("*"):
        if should_skip(path, root):
            continue
        text = read_text(path)
        if not text:
            continue
        rel = path.relative_to(root).as_posix()
        for chunk in split_content(text):
            content_hash = hashlib.sha256(f"{rel}\n{chunk}".encode("utf-8")).hexdigest()
            db.add(CodeChunk(
                repo_id=repo.id,
                file_path=rel,
                language=path.suffix.lstrip("."),
                content=chunk,
                content_hash=content_hash,
            ))
            count += 1
    return count


def should_skip(path: Path, root: Path) -> bool:
    if path.is_dir():
        return True
    rel_parts = set(path.relative_to(root).parts)
    if rel_parts & {".git", "node_modules", "target", "dist", "build", ".idea", ".vscode", "__pycache__"}:
        return True
    if path.suffix.lower() not in TEXT_EXTENSIONS:
        return True
    return path.stat().st_size > 800_000


def read_text(path: Path) -> str:
    for encoding in ("utf-8", "gbk", "latin-1"):
        try:
            return path.read_text(encoding=encoding, errors="ignore")
        except Exception:
            continue
    return ""


def split_content(text: str, max_chars: int = 3500) -> list[str]:
    lines = text.splitlines()
    chunks: list[str] = []
    current: list[str] = []
    size = 0
    for line in lines:
        current.append(line)
        size += len(line) + 1
        if size >= max_chars:
            chunks.append("\n".join(current))
            current = []
            size = 0
    if current:
        chunks.append("\n".join(current))
    return chunks


def search_code(db: Session, repo_ids: list[int], query: str, limit: int = 8) -> list[CodeChunk]:
    terms = extract_terms(query)
    if not terms:
        return []
    candidates = db.query(CodeChunk).filter(CodeChunk.repo_id.in_(repo_ids)).limit(5000).all()
    scored: list[tuple[int, CodeChunk]] = []
    for chunk in candidates:
        haystack = f"{chunk.file_path}\n{chunk.content}".lower()
        score = sum(haystack.count(term.lower()) for term in terms)
        if score:
            scored.append((score, chunk))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [chunk for _, chunk in scored[:limit]]


def extract_terms(text: str) -> list[str]:
    stack_like = re.findall(r"[A-Za-z_][\w.$]{2,}", text)
    chinese = re.findall(r"[\u4e00-\u9fa5]{2,}", text)
    terms = stack_like + chinese + expand_chinese_terms(text)
    seen: set[str] = set()
    output: list[str] = []
    for term in terms:
        normalized = term.strip(".")
        if normalized and normalized.lower() not in seen:
            seen.add(normalized.lower())
            output.append(normalized)
    return output[:60]


def expand_chinese_terms(text: str) -> list[str]:
    dictionary = {
        "首页": ["home", "main", "index", "dashboard"],
        "温度": ["temperature", "temp", "thermal", "degree"],
        "显示": ["display", "show", "render", "view", "text"],
        "页面": ["page", "activity", "fragment", "view", "screen"],
        "支付": ["pay", "payment", "paid"],
        "回调": ["callback", "notify", "notification"],
        "订单": ["order", "orderId"],
        "登录": ["login", "signin", "auth"],
        "鉴权": ["auth", "authorize", "permission"],
        "用户": ["user", "account"],
        "异常": ["exception", "error"],
        "空指针": ["null", "NullPointerException"],
        "接口": ["api", "controller", "endpoint"],
        "配置": ["config", "properties", "yaml"],
        "数据库": ["database", "repository", "mapper", "dao"],
        "缓存": ["cache", "redis"],
        "消息": ["message", "mq", "kafka", "rabbit"],
        "定时": ["schedule", "scheduler", "cron", "job"],
    }
    expanded: list[str] = []
    for keyword, terms in dictionary.items():
        if keyword in text:
            expanded.extend(terms)
    return expanded


async def analyze_with_model(model: AIModel | None, question: str, analysis_type: str, chunks: list[CodeChunk], log_text: str) -> str:
    context = format_context(chunks)
    prompt = build_prompt(question, analysis_type, context, log_text)
    if not model or not model.base_url or not model.api_key or not model.model_name:
        return local_analysis(question, analysis_type, chunks, log_text)

    url = model.base_url.rstrip("/")
    if not url.endswith("/chat/completions"):
        url = f"{url}/chat/completions"

    system_prompt = (
        "你是资深研发代码分析助手。日志是可选输入。"
        "如果没有提供日志，不要要求用户上传日志，直接基于给定代码上下文分析实现方式。"
        "如果代码上下文不足，要说明缺少哪些代码线索，并给出可继续检索的关键词。"
        "回答必须引用文件路径，区分事实和推测。"
    )
    payload = {
        "model": model.model_name,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
    }
    headers = {"Authorization": f"Bearer {model.api_key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(url, json=payload, headers=headers)
        response.raise_for_status()
        data = response.json()
    return data["choices"][0]["message"]["content"]


def build_prompt(question: str, analysis_type: str, context: str, log_text: str) -> str:
    log_section = f"\n日志内容：\n{log_text[:12000]}\n" if log_text.strip() else ""
    return f"""分析类型：{analysis_type}

用户问题：
{question}
{log_section}
检索到的代码上下文：
{context}

请输出：
1. 结论摘要
2. 相关代码文件和关键方法
3. 实现流程或问题根因
4. 事实依据和推测项
5. 下一步排查/继续阅读建议

注意：
- 如果没有日志内容，不要提“缺少日志”，直接按代码分析。
- 如果代码上下文没有命中，不要把原因归结为未上传日志。
"""


def format_context(chunks: list[CodeChunk]) -> str:
    if not chunks:
        return "未检索到相关代码片段。"
    parts = []
    for chunk in chunks:
        parts.append(f"文件：{chunk.file_path}\n```{chunk.language}\n{chunk.content[:3000]}\n```")
    return "\n\n".join(parts)


def local_analysis(question: str, analysis_type: str, chunks: list[CodeChunk], log_text: str) -> str:
    lines = [
        "## 结论摘要",
        "当前未配置可调用的 AI 模型，系统已基于关键词检索返回本地代码摘要。",
        "",
        f"- 分析类型：{analysis_type}",
        f"- 问题：{question or '未填写问题'}",
    ]
    if log_text.strip():
        lines.append(f"- 日志：已上传，长度 {len(log_text)} 字符")

    lines.extend(["", "## 命中的代码文件"])
    if chunks:
        for chunk in chunks:
            preview = " ".join(chunk.content.strip().split())[:260]
            lines.append(f"- `{chunk.file_path}`：{preview}")
    else:
        lines.append("- 未命中代码片段。建议换用更接近代码命名的关键词，例如页面类名、字段名、接口名、英文单词或具体 UI 文案。")

    lines.extend([
        "",
        "## 下一步建议",
        "- 配置可调用的 AI 模型后，可以获得完整的代码链路解释。",
        "- 如果当前问题是功能实现分析，不需要上传日志；只有排查运行异常时才需要日志。",
    ])
    return "\n".join(lines)
