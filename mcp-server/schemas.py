import re
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

REQUIRED_FILENAMES = ("README.md", "RESEARCH.md", "SOURCES.md")


def validate_filename(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,79}\.md", value) or re.fullmatch(r"(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\.md", value, re.I):
        raise ValueError("文件名必须是安全的根目录 Markdown 文件名。")
    return value


MarkdownFilename = Annotated[str, AfterValidator(validate_filename)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FilePlanItem(StrictModel):
    filename: MarkdownFilename
    purpose: str = Field(min_length=1, max_length=1000)
    priority: Literal["required", "recommended", "optional"]
    contentOutline: list[str] = Field(min_length=1, max_length=12)


class FilePlan(StrictModel):
    filePlan: list[FilePlanItem] = Field(min_length=3, max_length=20)

    @model_validator(mode="after")
    def validate_files(self):
        names = [item.filename.lower() for item in self.filePlan]
        if len(names) != len(set(names)):
            raise ValueError("文件计划不能包含重名文件（忽略大小写）。")
        if any(not any(item.filename == name and item.priority == "required" for item in self.filePlan) for name in REQUIRED_FILENAMES):
            raise ValueError("必须规划 README.md、RESEARCH.md、SOURCES.md，优先级 required。")
        if any(not item.purpose.strip() or any(not point.strip() or len(point) > 500 for point in item.contentOutline) for item in self.filePlan):
            raise ValueError("文件用途和内容要点不能为空，要点最多 500 字。")
        return self


class ResearchPlan(FilePlan):
    scenarioType: str
    researchQuestions: list[str] = Field(min_length=3, max_length=6)
    searchQueries: list[str] = Field(min_length=1, max_length=18)
    unknowns: list[str]


class ResearchQuestion(StrictModel):
    question: str = Field(min_length=1, max_length=1000)
    searchQueries: list[str] = Field(min_length=1, max_length=3)
    priority: Literal["high", "medium", "low"]


class MissingInformation(StrictModel):
    question: str
    whyNeeded: str
    priority: Literal["blocking", "optional"]


class RagResearchPlan(FilePlan):
    scenarioType: str
    researchQuestions: list[ResearchQuestion] = Field(min_length=3, max_length=6)
    missingInformation: list[MissingInformation]
    searchQueries: list[str] = Field(min_length=1, max_length=18)
    unknowns: list[str]


class SearchQueries(StrictModel):
    queries: list[str] = Field(min_length=1, max_length=3)


class EvidenceDraft(StrictModel):
    claim: str
    source_indices: list[int] = Field(min_length=1, max_length=5)
    confidence: Literal["high", "medium", "low"]
    impact: str
    status: Literal["verified", "inference", "unconfirmed"]


class EvidenceResult(StrictModel):
    cards: list[EvidenceDraft] = Field(max_length=5)


class GeneratedFile(StrictModel):
    filename: MarkdownFilename
    content: str = Field(min_length=1, max_length=12000)


class RagSaveContext(StrictModel):
    retrievalId: str
    contextVersion: int


class GeneratedWorkspace(StrictModel):
    files: list[GeneratedFile] = Field(min_length=3, max_length=20)
    summary: str
