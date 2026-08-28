"""Download public pothole datasets from the Hugging Face Hub and merge them
into a single YOLO-format dataset at ml/data/.

Every source class is collapsed to class 0 ("pothole"): the sources are all
single-hazard sets with inconsistent class ids.
"""
import random, shutil, zipfile
from pathlib import Path

from huggingface_hub import snapshot_download

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
OUT = ROOT / "data"
VAL_FRACTION = 0.15
IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}

SOURCES = [
    "Ryukijano/Pothole-detection-Yolov8",
    "rupesh002/pothole-detection-dataset",
    "rupesh002/pothole_dataset_2",
]


def fetch(repo_id: str) -> Path:
    local = Path(snapshot_download(repo_id, repo_type="dataset", local_dir=RAW / repo_id.replace("/", "__")))
    for z in local.rglob("*.zip"):
        marker = z.with_suffix(".extracted")
        if not marker.exists():
            with zipfile.ZipFile(z) as zf:
                zf.extractall(z.parent / z.stem)
            marker.touch()
    return local


def label_for(image: Path) -> Path | None:
    """YOLO layout puts labels in a sibling `labels/` dir mirroring `images/`."""
    parts = list(image.parts)
    if "images" not in parts:
        return None
    parts[len(parts) - 1 - parts[::-1].index("images")] = "labels"
    candidate = Path(*parts).with_suffix(".txt")
    return candidate if candidate.exists() else None


def collect(root: Path) -> list[tuple[Path, Path]]:
    pairs = []
    for img in root.rglob("*"):
        if img.suffix.lower() in IMG_EXT:
            lbl = label_for(img)
            if lbl:
                pairs.append((img, lbl))
    return pairs


def to_single_class(label_text: str) -> str:
    """Rewrite every class id to 0, dropping malformed rows."""
    rows = []
    for line in label_text.splitlines():
        f = line.split()
        if len(f) >= 5:
            rows.append(" ".join(["0", *f[1:5]]))
    return "\n".join(rows) + ("\n" if rows else "")


def main() -> None:
    pairs = []
    for repo in SOURCES:
        try:
            found = collect(fetch(repo))
        except Exception as exc:  # a source going missing must not kill the run
            print(f"  !! skipping {repo}: {exc}")
            continue
        print(f"  {repo}: {len(found)} labelled images")
        pairs += found

    if not pairs:
        raise SystemExit("no labelled images found - check network access to huggingface.co")

    random.Random(0).shuffle(pairs)
    split_at = int(len(pairs) * (1 - VAL_FRACTION))

    if OUT.exists():
        shutil.rmtree(OUT)
    for split, chunk in (("train", pairs[:split_at]), ("val", pairs[split_at:])):
        (OUT / split / "images").mkdir(parents=True)
        (OUT / split / "labels").mkdir(parents=True)
        for i, (img, lbl) in enumerate(chunk):
            stem = f"{i:06d}"
            shutil.copyfile(img, OUT / split / "images" / f"{stem}{img.suffix.lower()}")
            (OUT / split / "labels" / f"{stem}.txt").write_text(to_single_class(lbl.read_text()))
        print(f"{split}: {len(chunk)} images")

    (OUT / "data.yaml").write_text(
        f"path: {OUT.as_posix()}\ntrain: train/images\nval: val/images\nnc: 1\nnames: [pothole]\n"
    )
    print(f"\nwrote {OUT / 'data.yaml'}")


if __name__ == "__main__":
    main()
