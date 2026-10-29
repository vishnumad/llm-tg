export const IMAGE_SHAPES = ["square", "portrait", "landscape"] as const;

export type ImageShape = (typeof IMAGE_SHAPES)[number];

export type ImageRequest = {
  prompt: string;
  shape?: ImageShape;
};

export interface ImageProvider {
  name: string;
  generate(request: ImageRequest): Promise<Uint8Array>;
}
