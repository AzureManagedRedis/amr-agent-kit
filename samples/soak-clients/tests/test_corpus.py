import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MUTATIONS = ROOT / "mutations"


class CorpusContractTests(unittest.TestCase):
    def test_manifest_names_all_clients_and_mutations(self) -> None:
        manifest = json.loads((ROOT / "corpus.manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(5, len(manifest["clients"]))
        self.assertEqual(16, len(json.loads((MUTATIONS / "catalog.json").read_text(encoding="utf-8"))["mutations"]))
        for client in manifest["clients"]:
            self.assertTrue((ROOT / client["path"]).is_dir())

    def test_patches_create_executable_bad_tree(self) -> None:
        repository = ROOT.parents[1]
        for patch in sorted((MUTATIONS / "patches").glob("*.patch")):
            with tempfile.TemporaryDirectory(dir=ROOT, prefix=".mutation-test-") as temporary:
                worktree = Path(temporary)
                shutil.copytree(MUTATIONS / "reference-good", worktree / "reference-good")
                result = subprocess.run(
                    [
                        "git",
                        "apply",
                        f"--directory={worktree.relative_to(repository).as_posix()}",
                        str(patch.relative_to(repository)),
                    ],
                    cwd=repository,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(0, result.returncode, f"{patch.name}: {result.stderr}")
                fixture = subprocess.run(
                    ["python", str(worktree / "reference-good" / "soak_client.py")],
                    text=True,
                    capture_output=True,
                    check=True,
                )
                self.assertEqual("mutated", json.loads(fixture.stdout)["status"], patch.name)

    def test_retention_contract_has_required_trees(self) -> None:
        document = (ROOT / "artifact-contract.md").read_text(encoding="utf-8")
        for required in ("reference-good", "bad", "with-skill", "without-skill", "hashes.json", "reproduce.ps1", "reports/"):
            self.assertIn(required, document)

    def test_no_sensitive_literals_or_build_outputs_are_retained(self) -> None:
        forbidden = ("password=", "accountkey=", "sharedaccesssignature=", "authorization: bearer ")
        excluded_names = {"node_modules", "target", "bin", "obj", "__pycache__"}
        for path in ROOT.rglob("*"):
            if path.name == "__pycache__" and "tests" in path.parts:
                continue
            self.assertNotIn(path.name, excluded_names, path)
            if path.is_file() and "tests" not in path.parts:
                content = path.read_text(encoding="utf-8", errors="ignore").lower()
                self.assertFalse(any(value in content for value in forbidden), path)


if __name__ == "__main__":
    unittest.main()
