"""Exercise the material-change gate embedded in the storefront refresh workflow."""

import json
import os
import re
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/refresh-storefronts.yml"
PUBLIC_PATHS = (
    "public/data/storefronts/metadata.json",
    "public/data/storefronts/areas.json",
    "public/data/storefronts/vacant.geojson",
    "public/data/storefronts/boundaries.geojson",
)
REPORT_PATH = "data/processed/storefronts/report.json"


def detector_source():
    workflow = WORKFLOW.read_text(encoding="utf-8")
    match = re.search(
        r"^ {10}python3 - <<'PY' \| tee -a \"\$\{GITHUB_STEP_SUMMARY\}\"\n"
        r"(?P<script>.*?)^ {10}PY$",
        workflow,
        re.MULTILINE | re.DOTALL,
    )
    assert match, "workflow material-change detector heredoc is missing"
    return textwrap.dedent(match.group("script"))


def json_bytes(document):
    return (json.dumps(document, sort_keys=True) + "\n").encode()


def seed_documents(root, documents):
    for path, document in documents.items():
        destination = root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(json_bytes(document))


def run_detector(tmp_path, documents):
    root = tmp_path / "repo"
    root.mkdir(exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "test"], cwd=root, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"], cwd=root, check=True
    )
    seed_documents(root, documents)
    subprocess.run(["git", "add", "."], cwd=root, check=True)
    subprocess.run(["git", "commit", "-qm", "baseline"], cwd=root, check=True)

    changed_documents = json.loads(json.dumps(documents))
    changed_documents[PUBLIC_PATHS[0]]["retrievedAt"] = "2026-10-10T00:00:00Z"
    changed_documents[PUBLIC_PATHS[0]]["source"]["updatedAt"] = "2026-10-10T00:00:00Z"
    changed_documents[PUBLIC_PATHS[0]]["boundarySources"][0]["updatedAt"] = (
        "2026-10-10T00:00:00Z"
    )
    seed_documents(root, changed_documents)

    output_path = tmp_path / "github-output"
    summary_path = tmp_path / "github-summary"
    env = {
        **os.environ,
        "GITHUB_OUTPUT": str(output_path),
        "GITHUB_STEP_SUMMARY": str(summary_path),
    }
    result = subprocess.run(
        ["python3", "-c", detector_source()],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    return root, changed_documents, result, output_path


def sample_documents(content_hash="a" * 64):
    metadata = {
        "contentHash": content_hash,
        "retrievedAt": "2026-10-03T00:00:00Z",
        "source": {"updatedAt": "2026-10-03T00:00:00Z", "rows": 3},
        "boundarySources": [{"updatedAt": "2026-10-03T00:00:00Z"}],
        "recordCount": 1,
        "periodArtifacts": [
            {
                "reportingYear": "2024",
                "areasPath": "areas.json",
                "vacantPath": "vacant.geojson",
            },
            {
                "reportingYear": "2023",
                "areasPath": "periods/2023/areas.json",
                "vacantPath": "periods/2023/vacant.geojson",
            },
            {
                "reportingYear": "2019 and 2020",
                "areasPath": "periods/2019-and-2020/areas.json",
                "vacantPath": "periods/2019-and-2020/vacant.geojson",
            },
        ],
    }
    return {
        PUBLIC_PATHS[0]: metadata,
        PUBLIC_PATHS[1]: {"areas": [{"code": "MN01", "count": 1}]},
        PUBLIC_PATHS[2]: {"features": []},
        PUBLIC_PATHS[3]: {"features": []},
        "public/data/storefronts/periods/2023/areas.json": {
            "areas": [{"code": "MN01", "count": 3}]
        },
        "public/data/storefronts/periods/2023/vacant.geojson": {"features": []},
        "public/data/storefronts/periods/2019-and-2020/areas.json": {
            "areas": [{"code": "MN01", "count": 4}]
        },
        "public/data/storefronts/periods/2019-and-2020/vacant.geojson": {"features": []},
        REPORT_PATH: {"generatedAt": "2026-10-03T00:00:00Z", "pointExclusions": {}},
    }


class StorefrontWorkflowTests(unittest.TestCase):
    def test_timestamp_only_refresh_is_a_noop(self):
        with tempfile.TemporaryDirectory() as directory:
            _, _, result, output_path = run_detector(Path(directory), sample_documents())

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("changed=false", output_path.read_text(encoding="utf-8"))


    def test_material_artifact_and_hash_change_is_committable(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            documents = sample_documents()
            root, changed_documents, _, output_path = run_detector(tmp_path, documents)
            changed_documents[PUBLIC_PATHS[0]]["contentHash"] = "b" * 64
            changed_documents[PUBLIC_PATHS[0]]["recordCount"] = 2
            seed_documents(root, changed_documents)

            # Re-run the gate against the same HEAD so only the generated artifacts move.
            result = subprocess.run(
                ["python3", "-c", detector_source()],
                cwd=root,
                env={
                    **os.environ,
                    "GITHUB_OUTPUT": str(output_path),
                    "GITHUB_STEP_SUMMARY": str(tmp_path / "summary"),
                },
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("changed=true", output_path.read_text(encoding="utf-8"))


    def test_hash_and_material_disagreement_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            documents = sample_documents()
            root, changed_documents, _, output_path = run_detector(tmp_path, documents)
            changed_documents[PUBLIC_PATHS[0]]["contentHash"] = "b" * 64
            seed_documents(root, changed_documents)
            result = subprocess.run(
                ["python3", "-c", detector_source()],
                cwd=root,
                env={
                    **os.environ,
                    "GITHUB_OUTPUT": str(output_path),
                    "GITHUB_STEP_SUMMARY": str(tmp_path / "summary"),
                },
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1)
            self.assertIn("disagree", result.stdout)

    def test_older_period_payload_change_is_detected(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            root, changed_documents, _, output_path = run_detector(
                tmp_path, sample_documents()
            )
            changed_documents[PUBLIC_PATHS[0]]["contentHash"] = "b" * 64
            changed_documents[
                "public/data/storefronts/periods/2019-and-2020/areas.json"
            ]["areas"][0]["count"] = 5
            seed_documents(root, changed_documents)
            result = subprocess.run(
                ["python3", "-c", detector_source()],
                cwd=root,
                env={
                    **os.environ,
                    "GITHUB_OUTPUT": str(output_path),
                    "GITHUB_STEP_SUMMARY": str(tmp_path / "summary"),
                },
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("changed=true", output_path.read_text(encoding="utf-8"))

    def test_removed_period_is_detected_for_directory_staging(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            root, changed_documents, _, output_path = run_detector(
                tmp_path, sample_documents()
            )
            metadata = changed_documents[PUBLIC_PATHS[0]]
            metadata["contentHash"] = "b" * 64
            metadata["periodArtifacts"] = [
                item for item in metadata["periodArtifacts"]
                if item["reportingYear"] != "2019 and 2020"
            ]
            for suffix in ("areas.json", "vacant.geojson"):
                path = root / "public/data/storefronts/periods/2019-and-2020" / suffix
                path.unlink()
            seed_documents(root, changed_documents)
            result = subprocess.run(
                ["python3", "-c", detector_source()],
                cwd=root,
                env={
                    **os.environ,
                    "GITHUB_OUTPUT": str(output_path),
                    "GITHUB_STEP_SUMMARY": str(tmp_path / "summary"),
                },
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("changed=true", output_path.read_text(encoding="utf-8"))

    def test_unsafe_manifest_path_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            root, changed_documents, _, output_path = run_detector(
                tmp_path, sample_documents()
            )
            changed_documents[PUBLIC_PATHS[0]]["periodArtifacts"][1][
                "areasPath"
            ] = "../../outside.json"
            seed_documents(root, changed_documents)
            result = subprocess.run(
                ["python3", "-c", detector_source()],
                cwd=root,
                env={
                    **os.environ,
                    "GITHUB_OUTPUT": str(output_path),
                    "GITHUB_STEP_SUMMARY": str(tmp_path / "summary"),
                },
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1)
            self.assertIn("unsafe areasPath", result.stdout)


    def test_workflow_is_weekly_keyless_and_scoped_to_named_artifacts(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        deploy = (ROOT / ".github/workflows/deploy.yml").read_text(encoding="utf-8")
        gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")

        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("Bypass the source-metadata cache", workflow)
        self.assertIn("refresh.py --force", workflow)
        self.assertIn("- cron: '23 12 * * 0'", workflow)
        self.assertIn("permissions:\n  contents: write", workflow)
        self.assertIn("uses: actions/cache/restore@v4", workflow)
        self.assertIn("uses: actions/cache/save@v4", workflow)
        self.assertIn("path: data/cache/storefronts", workflow)
        self.assertIn("restore-keys:", workflow)
        self.assertIn("hashFiles('scripts/storefronts/*.py')", workflow)
        self.assertIn("${{ github.run_id }}", workflow)
        self.assertNotIn("secrets.", workflow)
        self.assertIn(
            "git add -A -- public/data/storefronts data/processed/storefronts/report.json",
            workflow,
        )
        self.assertIn('PUBLIC_DIR = "public/data/storefronts"', workflow)
        self.assertIn('METADATA = f"{PUBLIC_DIR}/metadata.json"', workflow)
        self.assertIn('BOUNDARIES = f"{PUBLIC_DIR}/boundaries.geojson"', workflow)
        self.assertIn("periods/{slug}/areas.json", workflow)
        self.assertIn("periods/{slug}/vacant.geojson", workflow)
        self.assertIn(REPORT_PATH, workflow)
        self.assertIn("- refresh-storefronts", deploy)
        self.assertIn("data/cache/storefronts/", gitignore)
        self.assertIn("data/raw/storefronts/", gitignore)
