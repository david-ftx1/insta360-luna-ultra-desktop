import { describe, expect, it } from "vitest";
import { yuvToNewRgba, yuvToRgba, type YuvFrame } from "~/utils/yuv";

/** A flat (single-value-per-plane) frame, 4:2:0 by default. */
function flatFrame(options: {
  width: number;
  height: number;
  y: number;
  cb: number;
  cr: number;
  chromaWidth?: number;
  chromaHeight?: number;
  bitDepth?: number;
}): YuvFrame {
  const {
    width,
    height,
    y,
    cb,
    cr,
    chromaWidth = Math.max(1, width / 2),
    chromaHeight = Math.max(1, height / 2),
    bitDepth = 8,
  } = options;
  return {
    y: new Uint16Array(width * height).fill(y),
    cb: new Uint16Array(chromaWidth * chromaHeight).fill(cb),
    cr: new Uint16Array(chromaWidth * chromaHeight).fill(cr),
    width,
    height,
    chromaWidth,
    chromaHeight,
    bitDepth,
  };
}

/** [r, g, b, a] at pixel (col, row) of an RGBA buffer `width` pixels wide. */
function pixelAt(rgba: Uint8ClampedArray, width: number, col: number, row: number) {
  const offset = (row * width + col) * 4;
  return [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]];
}

describe("yuvToRgba", () => {
  it("maps neutral chroma at the stream's nominal black and white points to 0 and 255", () => {
    const black = yuvToNewRgba(flatFrame({ width: 1, height: 1, y: 16, cb: 128, cr: 128 }));
    const white = yuvToNewRgba(flatFrame({ width: 1, height: 1, y: 235, cb: 128, cr: 128 }));

    expect(pixelAt(black, 1, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(white, 1, 0, 0)).toEqual([255, 255, 255, 255]);
  });

  it("produces an equal-channel grey for neutral (128/128) chroma at any luma", () => {
    const rgba = yuvToNewRgba(flatFrame({ width: 1, height: 1, y: 150, cb: 128, cr: 128 }));
    const [r, g, b] = pixelAt(rgba, 1, 0, 0);

    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it("scales 10-bit samples to the same output as the equivalent 8-bit ones", () => {
    // 150/255 and 128/255 re-expressed on a 10-bit (0-1023) scale.
    const eightBit = yuvToNewRgba(flatFrame({ width: 1, height: 1, y: 150, cb: 128, cr: 128 }));
    const tenBit = yuvToNewRgba(
      flatFrame({
        width: 1,
        height: 1,
        y: Math.round((150 * 1023) / 255),
        cb: Math.round((128 * 1023) / 255),
        cr: Math.round((128 * 1023) / 255),
        bitDepth: 10,
      }),
    );

    // The 10-bit sample only approximates the 8-bit one (integer rounding in
    // both directions), so allow the conversion to land within a shade.
    for (let channel = 0; channel < 3; channel++) {
      expect(tenBit[channel]).toBeGreaterThanOrEqual(eightBit[channel]! - 2);
      expect(tenBit[channel]).toBeLessThanOrEqual(eightBit[channel]! + 2);
    }
  });

  it("upsamples 4:2:0 chroma with nearest-neighbour, independently per quadrant", () => {
    const width = 4;
    const height = 4;
    const quadrants: [cb: number, cr: number][] = [
      [100, 128],
      [128, 160],
      [160, 100],
      [140, 140],
    ];

    const frame: YuvFrame = {
      y: new Uint16Array(width * height).fill(128),
      cb: new Uint16Array(4),
      cr: new Uint16Array(4),
      width,
      height,
      chromaWidth: 2,
      chromaHeight: 2,
      bitDepth: 8,
    };
    quadrants.forEach(([cb, cr], index) => {
      frame.cb[index] = cb;
      frame.cr[index] = cr;
    });

    const rgba = yuvToNewRgba(frame);

    // Each 2x2 luma quadrant should match a flat frame built from its own
    // quadrant's chroma alone — i.e. every pixel in that quadrant takes its
    // chroma from the single chroma sample nearest to it, not an average.
    const corners: [col: number, row: number][] = [
      [0, 0],
      [3, 0],
      [0, 3],
      [3, 3],
    ];
    quadrants.forEach(([cb, cr], index) => {
      const [col, row] = corners[index]!;
      const reference = yuvToNewRgba(flatFrame({ width: 1, height: 1, y: 128, cb, cr }));
      expect(pixelAt(rgba, width, col, row)).toEqual(pixelAt(reference, 1, 0, 0));
    });
  });

  it("throws rather than writing out of bounds when the output buffer is too small", () => {
    const frame = flatFrame({ width: 4, height: 4, y: 128, cb: 128, cr: 128 });
    const tooSmall = new Uint8ClampedArray(4 * 4 * 4 - 1);

    expect(() => yuvToRgba(frame, tooSmall)).toThrow(/too small/);
  });
});

describe("yuvToNewRgba", () => {
  it("allocates a buffer sized exactly to width * height * 4", () => {
    const frame = flatFrame({ width: 3, height: 5, y: 128, cb: 128, cr: 128 });

    expect(yuvToNewRgba(frame)).toHaveLength(3 * 5 * 4);
  });
});
