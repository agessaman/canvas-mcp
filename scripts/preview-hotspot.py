#!/usr/bin/env python3
"""Draw a hot-spot region onto an image so it can be checked before it ships.

Why this exists
---------------
A misplaced hot-spot is invisible everywhere except in front of a student. The
payload validates, the readback is byte-perfect, the Canvas editor renders it
happily — and the clickable region is over the wrong part of the picture. The
first hotspots authored through this server were all like that: correct, and
wrong. Nothing in the API could have caught it, because nothing about the item
is malformed.

So the check has to be visual. Draw the region, look at it, then create the
item. Comparing "is the box on the thing I meant" is a judgement anyone can
make; producing coordinates from scratch is not.

This is a development script rather than an MCP tool on purpose: the only
pure-JS image library that handles PNG and JPEG weighs 31MB against a 3.4MB
extension bundle, to do something the machine running this repo already has
Pillow for.

Usage
-----
  # rectangle, in pixels (what an image viewer gives you)
  preview-hotspot.py map.png out.png --rect 250 100 500 200

  # rectangle, in fractions of the image
  preview-hotspot.py map.png out.png --rect 0.25 0.2 0.5 0.4 --fractions

  # arbitrary polygon
  preview-hotspot.py map.png out.png --polygon 100,100 400,120 380,300

Prints the fractional coordinates to pass to create-new-quiz-item, so the
numbers that were checked are the numbers that get sent.
"""
import argparse
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("Pillow is required: pip install Pillow")


def parse_point(text):
    try:
        x, y = text.split(",")
        return float(x), float(y)
    except ValueError:
        raise argparse.ArgumentTypeError(f"expected x,y — got {text!r}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image")
    ap.add_argument("output")
    ap.add_argument("--rect", nargs=4, type=float, metavar=("X", "Y", "W", "H"))
    ap.add_argument("--polygon", nargs="+", type=parse_point, metavar="X,Y")
    ap.add_argument("--fractions", action="store_true",
                    help="coordinates are already fractions of the image (0-1)")
    args = ap.parse_args()

    if bool(args.rect) == bool(args.polygon):
        ap.error("give exactly one of --rect or --polygon")

    image = Image.open(args.image).convert("RGBA")
    width, height = image.size

    if args.rect:
        x, y, w, h = args.rect
        points = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    else:
        points = list(args.polygon)

    # Canvas stores fractions; pixels are just the friendlier way to say them.
    if args.fractions:
        fractions = points
        pixels = [(fx * width, fy * height) for fx, fy in points]
    else:
        pixels = points
        fractions = [(px / width, py / height) for px, py in points]

    outside = [(fx, fy) for fx, fy in fractions if not (0 <= fx <= 1 and 0 <= fy <= 1)]
    if outside:
        print(f"WARNING: {len(outside)} point(s) fall outside the {width}x{height} image "
              f"and will never be clickable: {outside}", file=sys.stderr)

    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.polygon(pixels, fill=(70, 130, 220, 90), outline=(20, 80, 180, 255), width=3)
    Image.alpha_composite(image, overlay).convert("RGB").save(args.output)

    print(f"image: {width} x {height} px")
    print(f"wrote: {args.output}")
    print("\nPass to create-new-quiz-item as fractions:")
    print("  hotspotPolygon: ["
          + ", ".join(f"{{x: {fx:.4f}, y: {fy:.4f}}}" for fx, fy in fractions) + "]")
    print(f"\nOr in pixels, with imagePixelWidth: {width}, imagePixelHeight: {height}:")
    print("  hotspotPolygon: ["
          + ", ".join(f"{{x: {px:.0f}, y: {py:.0f}}}" for px, py in pixels) + "]")


if __name__ == "__main__":
    main()
