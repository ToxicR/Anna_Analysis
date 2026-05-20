from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    code: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    repos: Mapped[list["GitRepo"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class GitRepo(Base):
    __tablename__ = "git_repos"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    name: Mapped[str] = mapped_column(String(160))
    git_url: Mapped[str] = mapped_column(Text)
    branch: Mapped[str] = mapped_column(String(120), default="main")
    access_token: Mapped[str] = mapped_column(Text, default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    local_path: Mapped[str] = mapped_column(Text, default="")
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    project: Mapped[Project] = relationship(back_populates="repos")
    chunks: Mapped[list["CodeChunk"]] = relationship(back_populates="repo", cascade="all, delete-orphan")


class AIModel(Base):
    __tablename__ = "ai_models"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    provider: Mapped[str] = mapped_column(String(80), default="openai-compatible")
    base_url: Mapped[str] = mapped_column(Text, default="")
    api_key: Mapped[str] = mapped_column(Text, default="")
    model_name: Mapped[str] = mapped_column(String(160), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(120), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class CodeChunk(Base):
    __tablename__ = "code_chunks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    repo_id: Mapped[int] = mapped_column(ForeignKey("git_repos.id"), index=True)
    file_path: Mapped[str] = mapped_column(Text, index=True)
    language: Mapped[str] = mapped_column(String(40), default="")
    content: Mapped[str] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    repo: Mapped[GitRepo] = relationship(back_populates="chunks")


class AnalysisTask(Base):
    __tablename__ = "analysis_tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    model_id: Mapped[int | None] = mapped_column(ForeignKey("ai_models.id"), nullable=True)
    analysis_type: Mapped[str] = mapped_column(String(40))
    question: Mapped[str] = mapped_column(Text)
    log_text: Mapped[str] = mapped_column(Text, default="")
    selected_repo_ids: Mapped[str] = mapped_column(String(240), default="")
    status: Mapped[str] = mapped_column(String(40), default="completed")
    result: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
