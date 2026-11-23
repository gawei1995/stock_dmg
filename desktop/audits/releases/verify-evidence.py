#!/usr/bin/env python3
"""Verify frozen release input evidence without extracting or executing it."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def js_json_hash(value):
    # The original inventory hashes use JSON.stringify with this key order.
    return sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())


def relative_path(value):
    require(isinstance(value, str) and value, "Empty evidence path")
    path = PurePosixPath(value)
    require(
        not path.is_absolute()
        and "\\" not in value
        and all(part not in ("", ".", "..") for part in value.split("/")),
        f"Unsafe evidence path: {value}",
    )
    return value


def verify(directory, artifact_root=None):
    evidence = json.loads((directory / "evidence.json").read_text())
    raw_manifest = (directory / "verification.json").read_bytes()
    require(sha256(raw_manifest) == evidence["originalManifest"]["sha256"], "Original manifest hash differs")
    manifest = json.loads(raw_manifest)
    require(manifest["app"]["version"] == evidence["version"], "Evidence versions differ")

    source = manifest["source"]
    skills = manifest["bundledSkills"]
    expected = {}
    for inventory, prefix in ((source, "desktop/"), (skills, "trading-agent-workspace/.agents/skills/")):
        require(inventory["algorithm"] == "sha256", "Unsupported input digest algorithm")
        require(js_json_hash(inventory["files"]) == inventory["treeHash"], "Inventory tree hash differs")
        for record in inventory["files"]:
            require(record["kind"] == "file", "Only regular frozen input files are allowed")
            name = prefix + relative_path(record["path"])
            require(name not in expected, f"Duplicate inventory input: {name}")
            expected[name] = record

    fingerprint = js_json_hash({
        "source": source["treeHash"],
        "skills": skills["treeHash"],
        "dependencyLock": manifest["dependencyLock"]["sha256"],
    })
    require(fingerprint == source["inputHash"] == evidence["inputFingerprint"], "Release input fingerprint differs")
    lock_name = "desktop/" + relative_path(manifest["dependencyLock"]["path"])
    require(lock_name in expected, "Dependency lock is absent from source input inventory")
    require(
        expected[lock_name]["sha256"] == manifest["dependencyLock"]["sha256"] == evidence["dependencyLockSha256"],
        "Dependency lock digest differs",
    )

    archive_record = evidence["sharedSourceArchive"]
    archive_path = directory / relative_path(archive_record["path"])
    require(archive_path.stat().st_size == archive_record["bytes"], "Shared input archive size differs")
    require(file_hash(archive_path) == archive_record["sha256"], "Shared input archive hash differs")
    seen = set()
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive:
            name = relative_path(member.name)
            require(member.isfile() and not member.pax_headers, f"Unexpected archive member type or metadata: {name}")
            require(name not in seen, f"Duplicate archive member: {name}")
            require(name in expected, f"Unexpected archive member: {name}")
            record = expected[name]
            require(member.size == record["bytes"], f"Input size differs: {name}")
            require(member.mode & 0o777 == record["mode"], f"Input mode differs: {name}")
            data = archive.extractfile(member).read()
            require(sha256(data) == record["sha256"], f"Input digest differs: {name}")
            seen.add(name)
    require(seen == set(expected), f"Missing archive inputs: {sorted(set(expected) - seen)}")
    require(len(seen) == archive_record["fileCount"], "Archive input count differs")

    artifacts = []
    for record in manifest["artifacts"]:
        if record["type"] not in ("dmg", "zip"):
            continue
        if artifact_root is None:
            artifacts.append({"type": record["type"], "status": "not_checked_no_binary_copy_supplied"})
            continue
        path = artifact_root / relative_path(record["path"])
        require(path.stat().st_size == record["bytes"], f"Binary artifact size differs: {path.name}")
        require(file_hash(path) == record["sha256"], f"Binary artifact hash differs: {path.name}")
        artifacts.append({"type": record["type"], "status": "hash_matches_historical_manifest"})

    return {
        "status": "verified_frozen_inputs",
        "version": evidence["version"],
        "sourceFiles": len(source["files"]),
        "bundledReviewSkillFiles": len(skills["files"]),
        "inputFingerprint": fingerprint,
        "archiveFileCount": len(seen),
        "binaryArtifacts": artifacts,
        "sourceExecuted": False,
        "buildOrTestsRun": False,
        "installedAppOrLiveServicesVerified": False,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(__file__).parent / "0.24.13")
    parser.add_argument("--artifact-root", type=Path, help="Optional desktop directory containing separately obtained release/DMG and ZIP files")
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.directory, args.artifact_root), ensure_ascii=False, indent=2))
    except (ValueError, KeyError, OSError, tarfile.TarError) as error:
        print(f"Evidence verification FAILED: {error}", file=sys.stderr)
        sys.exit(1)
