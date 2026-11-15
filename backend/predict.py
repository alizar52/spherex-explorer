"""Load the saved CNN and classify one or more FITS cutouts of one object."""

import argparse
import json
from pathlib import Path

import numpy as np
import torch
from astropy.io import fits
from torch import nn


def prepare_image(path, image_size):
    with fits.open(path, memmap=False) as hdus:
        image = np.asarray(hdus['IMAGE'].data, dtype=np.float32).astype(np.float64)

    if image.ndim != 2 or max(image.shape) > image_size:
        raise ValueError(f'Expected a 2D FITS IMAGE that fits in {image_size}×{image_size}: {path}')

    valid = np.isfinite(image)
    if not valid.any():
        raise ValueError(f'No finite pixels in {path}')

    pixels = image[valid]
    median = np.median(pixels)
    spread = max(1.4826 * np.median(np.abs(pixels - median)), 1e-8)
    normalized = np.zeros(image.shape)
    normalized[valid] = np.clip((pixels - median) / spread, -10, 10)

    height, width = image.shape
    top = (image_size - height) // 2
    left = (image_size - width) // 2
    channels = np.zeros((2, image_size, image_size), dtype=np.float32)
    channels[0, top:top + height, left:left + width] = normalized
    channels[1, top:top + height, left:left + width] = valid
    return torch.from_numpy(channels)


class FitsClassifier:
    def __init__(self, checkpoint_path):
        checkpoint = torch.load(checkpoint_path, map_location='cpu', weights_only=True)
        self.class_names = checkpoint['class_names']
        self.image_size = checkpoint['image_size']
        pool_size = checkpoint['pool_size']
        self.model = nn.Sequential(
            nn.Conv2d(2, 16, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(16, 32, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.AdaptiveAvgPool2d((pool_size, pool_size)),
            nn.Flatten(),
            nn.Dropout(0.25),
            nn.Linear(32 * pool_size * pool_size, len(self.class_names)),
        )
        self.model.load_state_dict(checkpoint['model_state'])
        self.model.eval()

    @torch.inference_mode()
    def predict(self, fits_paths):
        images = [prepare_image(path, self.image_size) for path in fits_paths]
        if not images:
            raise ValueError('Provide at least one FITS observation of the object')
        probabilities = self.model(torch.stack(images)).softmax(dim=1).mean(dim=0)
        return {
            'category': self.class_names[probabilities.argmax().item()],
            'scores': dict(zip(self.class_names, probabilities.tolist())),
            'observations': len(images),
        }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('checkpoint', type=Path)
    parser.add_argument('fits', nargs='+', type=Path)
    args = parser.parse_args()
    classifier = FitsClassifier(args.checkpoint)
    print(json.dumps(classifier.predict(args.fits), indent=2))
