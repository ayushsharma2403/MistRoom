"""Root shortcut for MistRoom AI triage and summarization engine."""
from backend.ai import RULES, triage, summarize

__all__ = ["RULES", "triage", "summarize"]
