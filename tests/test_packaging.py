from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_dockerfile_packaging():
    dockerfile_path = REPO_ROOT / "Dockerfile"
    assert dockerfile_path.exists(), "Dockerfile does not exist"
    
    content = dockerfile_path.read_text(encoding="utf-8")
    copy_lines = [
        line.strip()
        for line in content.splitlines()
        if line.strip().startswith("COPY ")
    ]
    
    has_shared = any("shared" in line for line in copy_lines)
    has_backend = any("backend" in line for line in copy_lines)
    has_frontend = any("frontend" in line for line in copy_lines)

    assert has_shared, f"shared not found in COPY lines: {copy_lines}"
    assert has_backend, f"backend not found in COPY lines: {copy_lines}"
    assert has_frontend, f"frontend not found in COPY lines: {copy_lines}"


def test_shared_triage_rules_exists():
    rules_path = REPO_ROOT / "shared" / "triage_rules.json"
    assert rules_path.exists(), f"Expected file not found: {rules_path}"


def test_requirements_cryptography():
    req_path = REPO_ROOT / "requirements.txt"
    assert req_path.exists(), "requirements.txt does not exist"
    content = req_path.read_text(encoding="utf-8")
    req_lines = [line.strip() for line in content.splitlines() if line.strip()]
    assert any("cryptography" in line for line in req_lines), "cryptography not in requirements.txt"
