export const IMAGE_SHAPES = ["square", "portrait", "landscape"] as const;

export type ImageShape = (typeof IMAGE_SHAPES)[number];

export type ImageRequest = {
  prompt: string;
  shape?: ImageShape;
  /** Images to edit or draw from, each within `maxInputSide`. */
  inputs?: Uint8Array[];
};

export interface ImageProvider {
  name: string;
  /** Longest side, in pixels, an input image may have. */
  maxInputSide: number;
  generate(request: ImageRequest): Promise<Uint8Array>;
}
