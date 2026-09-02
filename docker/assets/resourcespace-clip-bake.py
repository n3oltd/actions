"""Downloads everything the CLIP service loads, at image build time.

The runtime sets HF_HUB_OFFLINE, so whatever this misses is a container that will
not start. The model is read out of the service rather than named here, so the
image cannot bake one model and load another.
"""

import os
import re
import sys

import open_clip
from huggingface_hub import snapshot_download
from open_clip.pretrained import get_pretrained_cfg

SERVICE = "/opt/clip/clip_service.py"
source = open(SERVICE, encoding="utf-8").read()


def constant(name: str) -> str:
    match = re.search(r'^%s = "(.+)"$' % name, source, re.M)
    if not match:
        sys.exit(f"bake: {name} not found in {SERVICE}")
    return match.group(1)


model_name = constant("MODEL_NAME")
pretrained = constant("MODEL_PRETRAINED")

cfg = get_pretrained_cfg(model_name, pretrained) or {}
repo = cfg.get("hf_hub", "").rstrip("/")
if not repo:
    sys.exit(f"bake: {model_name}/{pretrained} resolves to no Hugging Face repository")

print(f"bake: downloading {repo}", flush=True)
local_dir = snapshot_download(repo)

# transformers resolves a model config before constructing a tokenizer, even with
# the class already named in tokenizer_config.json. This is an open_clip model and
# ships no config.json; online the lookup 404s and is ignored, offline it is fatal.
config_json = os.path.join(local_dir, "config.json")
if not os.path.exists(config_json):
    print(f"bake: writing an empty {config_json} for the tokenizer lookup", flush=True)
    with open(config_json, "w", encoding="utf-8") as handle:
        handle.write("{}\n")

print(f"bake: warming open_clip for {model_name}/{pretrained}", flush=True)
open_clip.create_model_and_transforms(model_name, pretrained=pretrained)
open_clip.get_tokenizer(model_name)

print("bake: complete", flush=True)
