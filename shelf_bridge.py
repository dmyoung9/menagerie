"""Read the shelf's authoritative per-model source without owning its schema."""
from functools import lru_cache
import importlib.util
from pathlib import Path


def enabled(trials):
    # A missing/broken staged engines.toml must not re-enable legacy INI writes.
    return (Path(trials) / "shelf").is_dir()


@lru_cache(maxsize=4)
def loader(trials):
    path = Path(trials) / "shelf_config.py"
    spec = importlib.util.spec_from_file_location("menagerie_shelf_configuration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def candidate(trials):
    return loader(str(trials)).load_configuration(Path(trials) / "shelf")


def inventory(trials, configuration=None):
    configuration = candidate(trials) if configuration is None else configuration
    serialize = loader(str(trials)).ini_value
    return {model: {key: serialize(value) for key, value in spec["runtime"].items()}
            for model, spec in configuration["models"].items()}
