from datetime import datetime
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .database import Base, UPLOAD_DIR, engine, get_db
from .models import AIModel, AnalysisTask, AppSetting, GitRepo, Project
from .services import analyze_with_model, search_code, sync_repo


Base.metadata.create_all(bind=engine)

app = FastAPI(title="Anna Analysis")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class ProjectIn(BaseModel):
    name: str
    description: str = ""
    enabled: bool = True


class RepoIn(BaseModel):
    project_id: int
    name: str
    git_url: str
    branch: str = "main"
    access_token: str = ""
    enabled: bool = True


class RepoSlotIn(BaseModel):
    git_url: str = ""
    branch: str = "main"


class ProjectWithReposIn(BaseModel):
    name: str
    description: str = ""
    enabled: bool = True
    android_repo: RepoSlotIn = RepoSlotIn()
    cpp_repo: RepoSlotIn = RepoSlotIn()


class ModelIn(BaseModel):
    name: str
    provider: str = "openai-compatible"
    base_url: str = ""
    api_key: str = ""
    model_name: str = ""
    enabled: bool = True
    is_default: bool = False


class GitLabTokenIn(BaseModel):
    access_token: str = ""


class AnalysisIn(BaseModel):
    project_id: int
    repo_ids: list[int]
    model_id: int | None = None
    analysis_type: str = ""
    question: str
    log_text: str = ""


class RepoSyncBatchIn(BaseModel):
    repo_ids: list[int]


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


def get_setting(db: Session, key: str) -> str:
    setting = db.get(AppSetting, key)
    return setting.value if setting else ""


def set_setting(db: Session, key: str, value: str) -> AppSetting:
    setting = db.get(AppSetting, key)
    if not setting:
        setting = AppSetting(key=key, value=value)
        db.add(setting)
    else:
        setting.value = value
        setting.updated_at = datetime.utcnow()
    return setting


def normalize_project_name(name: str) -> str:
    normalized_name = name.strip()
    if not normalized_name:
        raise HTTPException(400, "请填写项目名称")
    return normalized_name


def generate_project_code() -> str:
    return f"project-{datetime.utcnow().strftime('%Y%m%d%H%M%S%f')}"


def repo_kind(repo: GitRepo) -> str:
    name = repo.name.lower()
    if "c++" in name or "cpp" in name or "native" in name:
        return "C++"
    return "Android"


def find_repo_by_kind(repos: list[GitRepo], kind: str) -> GitRepo | None:
    for repo in repos:
        if repo_kind(repo) == kind:
            return repo
    return None


def apply_repo_slot(db: Session, project: Project, kind: str, payload: RepoSlotIn, existing_repos: list[GitRepo]) -> GitRepo | None:
    repo = find_repo_by_kind(existing_repos, kind)
    git_url = payload.git_url.strip()
    branch = payload.branch.strip() or "main"
    if not git_url:
        if repo:
            db.delete(repo)
        return None
    if not repo:
        repo = GitRepo(project_id=project.id, access_token="", enabled=True)
        db.add(repo)
    repo.name = f"{project.name} {kind}"
    repo.git_url = git_url
    repo.branch = branch
    repo.access_token = ""
    repo.enabled = True
    return repo


def commit_or_duplicate_error(db: Session):
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        message = str(exc.orig)
        if "projects.name" in message:
            raise HTTPException(400, "项目名称已存在，请换一个项目名称") from exc
        if "projects.code" in message:
            raise HTTPException(400, "内部项目编号重复，请重试") from exc
        raise HTTPException(400, "保存失败，请检查输入内容是否重复或无效") from exc


def infer_analysis_type(question: str, log_text: str) -> str:
    text = f"{question}\n{log_text}".lower()
    if log_text.strip() or any(term in text for term in ["exception", "error", "crash", "崩溃", "异常", "报错", "日志", "堆栈", "trace"]):
        return "incident"
    if any(term in text for term in ["review", "审查", "检查代码", "代码质量", "风险"]):
        return "review"
    if any(term in text for term in ["影响", "改动", "范围", "调用方", "依赖"]):
        return "impact"
    return "feature"


@app.get("/api/projects")
def list_projects(db: Session = Depends(get_db)):
    return db.query(Project).order_by(Project.id.desc()).all()


@app.post("/api/projects")
def create_project(payload: ProjectIn, db: Session = Depends(get_db)):
    name = normalize_project_name(payload.name)
    project = Project(
        name=name,
        code=generate_project_code(),
        description=payload.description.strip(),
        enabled=payload.enabled,
    )
    db.add(project)
    commit_or_duplicate_error(db)
    db.refresh(project)
    return project


@app.post("/api/projects/with-repos")
def create_project_with_repos(payload: ProjectWithReposIn, db: Session = Depends(get_db)):
    repo_slots = [
        ("Android", payload.android_repo),
        ("C++", payload.cpp_repo),
    ]
    filled_repos = [(kind, repo) for kind, repo in repo_slots if repo.git_url.strip()]
    if not filled_repos:
        raise HTTPException(400, "请至少填写 Android 仓库或 C++ 仓库中的一个")

    name = normalize_project_name(payload.name)
    project = Project(
        name=name,
        code=generate_project_code(),
        description=payload.description.strip(),
        enabled=payload.enabled,
    )
    db.add(project)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        message = str(exc.orig)
        if "projects.name" in message:
            raise HTTPException(400, "项目名称已存在，请换一个项目名称") from exc
        if "projects.code" in message:
            raise HTTPException(400, "内部项目编号重复，请重试") from exc
        raise HTTPException(400, "保存失败，请检查输入内容是否重复或无效") from exc

    repos: list[GitRepo] = []
    for kind, repo_payload in filled_repos:
        repo = GitRepo(
            project_id=project.id,
            name=f"{project.name} {kind}",
            git_url=repo_payload.git_url.strip(),
            branch=repo_payload.branch.strip() or "main",
            access_token="",
            enabled=True,
        )
        db.add(repo)
        repos.append(repo)

    commit_or_duplicate_error(db)
    db.refresh(project)
    for repo in repos:
        db.refresh(repo)
    return {"project": project, "repos": repos}


@app.put("/api/projects/{project_id}/with-repos")
def update_project_with_repos(project_id: int, payload: ProjectWithReposIn, db: Session = Depends(get_db)):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "项目不存在")

    if not payload.android_repo.git_url.strip() and not payload.cpp_repo.git_url.strip():
        raise HTTPException(400, "请至少填写 Android 仓库或 C++ 仓库中的一个")

    project.name = normalize_project_name(payload.name)
    project.description = payload.description.strip()
    project.enabled = payload.enabled

    existing_repos = db.query(GitRepo).filter(GitRepo.project_id == project.id).all()
    updated_repos = [
        repo
        for repo in [
            apply_repo_slot(db, project, "Android", payload.android_repo, existing_repos),
            apply_repo_slot(db, project, "C++", payload.cpp_repo, existing_repos),
        ]
        if repo is not None
    ]

    commit_or_duplicate_error(db)
    db.refresh(project)
    for repo in updated_repos:
        db.refresh(repo)
    return {"project": project, "repos": updated_repos}


@app.put("/api/projects/{project_id}")
def update_project(project_id: int, payload: ProjectIn, db: Session = Depends(get_db)):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "项目不存在")
    name = normalize_project_name(payload.name)
    project.name = name
    project.description = payload.description.strip()
    project.enabled = payload.enabled
    commit_or_duplicate_error(db)
    return project


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: int, db: Session = Depends(get_db)):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "项目不存在")
    db.delete(project)
    db.commit()
    return {"ok": True}


@app.get("/api/repos")
def list_repos(project_id: int | None = None, db: Session = Depends(get_db)):
    query = db.query(GitRepo)
    if project_id:
        query = query.filter(GitRepo.project_id == project_id)
    return query.order_by(GitRepo.id.desc()).all()


@app.post("/api/repos")
def create_repo(payload: RepoIn, db: Session = Depends(get_db)):
    if not db.get(Project, payload.project_id):
        raise HTTPException(404, "项目不存在")
    repo = GitRepo(**payload.model_dump())
    db.add(repo)
    db.commit()
    db.refresh(repo)
    return repo


@app.put("/api/repos/{repo_id}")
def update_repo(repo_id: int, payload: RepoIn, db: Session = Depends(get_db)):
    repo = db.get(GitRepo, repo_id)
    if not repo:
        raise HTTPException(404, "仓库不存在")
    for key, value in payload.model_dump().items():
        setattr(repo, key, value)
    db.commit()
    return repo


@app.delete("/api/repos/{repo_id}")
def delete_repo(repo_id: int, db: Session = Depends(get_db)):
    repo = db.get(GitRepo, repo_id)
    if not repo:
        raise HTTPException(404, "仓库不存在")
    db.delete(repo)
    db.commit()
    return {"ok": True}


@app.post("/api/repos/{repo_id}/sync")
def sync_git_repo(repo_id: int, db: Session = Depends(get_db)):
    repo = db.get(GitRepo, repo_id)
    if not repo:
        raise HTTPException(404, "仓库不存在")
    try:
        result = sync_repo(db, repo, get_setting(db, "gitlab_access_token"))
        repo.last_sync_at = datetime.utcnow()
        db.commit()
        return result
    except Exception as exc:
        db.rollback()
        raise HTTPException(400, f"同步失败：{exc}") from exc


@app.post("/api/repos/sync")
def sync_git_repos(payload: RepoSyncBatchIn, db: Session = Depends(get_db)):
    if not payload.repo_ids:
        raise HTTPException(400, "请至少选择一个仓库")

    repos = db.query(GitRepo).filter(GitRepo.id.in_(payload.repo_ids)).all()
    found_ids = {repo.id for repo in repos}
    missing_ids = [repo_id for repo_id in payload.repo_ids if repo_id not in found_ids]
    if missing_ids:
        raise HTTPException(404, f"仓库不存在：{', '.join(str(repo_id) for repo_id in missing_ids)}")

    token = get_setting(db, "gitlab_access_token")
    results = []
    for repo in repos:
        try:
            result = sync_repo(db, repo, token)
            repo.last_sync_at = datetime.utcnow()
            db.commit()
            results.append({"repo_id": repo.id, "repo_name": repo.name, **result})
        except Exception as exc:
            db.rollback()
            raise HTTPException(400, f"{repo.name} 刷新代码索引失败：{exc}") from exc
    return {"synced": results}


@app.get("/api/settings/gitlab-token")
def get_gitlab_token(db: Session = Depends(get_db)):
    token = get_setting(db, "gitlab_access_token")
    return {"configured": bool(token), "access_token": token}


@app.put("/api/settings/gitlab-token")
def update_gitlab_token(payload: GitLabTokenIn, db: Session = Depends(get_db)):
    set_setting(db, "gitlab_access_token", payload.access_token.strip())
    db.commit()
    return {"configured": bool(payload.access_token.strip())}


@app.get("/api/models")
def list_models(db: Session = Depends(get_db)):
    return db.query(AIModel).order_by(AIModel.id.desc()).all()


@app.post("/api/models")
def create_model(payload: ModelIn, db: Session = Depends(get_db)):
    if payload.is_default:
        db.query(AIModel).update({"is_default": False})
    model = AIModel(**payload.model_dump())
    db.add(model)
    db.commit()
    db.refresh(model)
    return model


@app.put("/api/models/{model_id}")
def update_model(model_id: int, payload: ModelIn, db: Session = Depends(get_db)):
    model = db.get(AIModel, model_id)
    if not model:
        raise HTTPException(404, "模型不存在")
    if payload.is_default:
        db.query(AIModel).filter(AIModel.id != model_id).update({"is_default": False})
    for key, value in payload.model_dump().items():
        setattr(model, key, value)
    db.commit()
    return model


@app.delete("/api/models/{model_id}")
def delete_model(model_id: int, db: Session = Depends(get_db)):
    model = db.get(AIModel, model_id)
    if not model:
        raise HTTPException(404, "模型不存在")
    db.delete(model)
    db.commit()
    return {"ok": True}


@app.post("/api/analyze")
async def analyze(payload: AnalysisIn, db: Session = Depends(get_db)):
    if not payload.repo_ids:
        raise HTTPException(400, "请至少选择一个仓库")
    project = db.get(Project, payload.project_id)
    if not project:
        raise HTTPException(404, "项目不存在")
    repos = db.query(GitRepo).filter(GitRepo.id.in_(payload.repo_ids), GitRepo.project_id == payload.project_id).all()
    if not repos:
        raise HTTPException(400, "仓库与项目不匹配")
    model = db.get(AIModel, payload.model_id) if payload.model_id else db.query(AIModel).filter(AIModel.is_default == True).first()
    chunks = search_code(db, [repo.id for repo in repos], f"{payload.question}\n{payload.log_text}")
    analysis_type = payload.analysis_type or infer_analysis_type(payload.question, payload.log_text)
    result = await analyze_with_model(model, payload.question, analysis_type, chunks, payload.log_text)
    task = AnalysisTask(
        project_id=payload.project_id,
        model_id=model.id if model else None,
        analysis_type=analysis_type,
        question=payload.question,
        log_text=payload.log_text,
        selected_repo_ids=",".join(str(repo_id) for repo_id in payload.repo_ids),
        result=result,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@app.post("/api/analyze/upload-log")
async def upload_log(file: UploadFile = File(...)):
    target = UPLOAD_DIR / file.filename
    content = await file.read()
    target.write_bytes(content)
    text = content.decode("utf-8", errors="ignore")
    return {"file_name": file.filename, "text": text[:200_000]}


@app.get("/api/tasks")
def list_tasks(project_id: int | None = None, db: Session = Depends(get_db)):
    query = db.query(AnalysisTask)
    if project_id:
        query = query.filter(AnalysisTask.project_id == project_id)
    return query.order_by(AnalysisTask.id.desc()).limit(50).all()


@app.delete("/api/tasks/{task_id}")
def delete_task(task_id: int, db: Session = Depends(get_db)):
    task = db.get(AnalysisTask, task_id)
    if not task:
        raise HTTPException(404, "分析历史不存在")
    db.delete(task)
    db.commit()
    return {"ok": True}


@app.delete("/api/tasks")
def clear_tasks(project_id: int | None = None, db: Session = Depends(get_db)):
    query = db.query(AnalysisTask)
    if project_id:
        query = query.filter(AnalysisTask.project_id == project_id)
    deleted = query.delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "deleted": deleted}
