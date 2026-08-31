import { pipeline } from "@huggingface/transformers";
import type { MemoryConfig } from "../shared/types.js";
import type { EmbeddingProvider } from "./types.js";

// ---------------------------------------------------------------------------
// Local embedding: transformers.js + ONNX, in-process
// ---------------------------------------------------------------------------

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly dims: number;
  #extract:
    | ((texts: string[], options: { pooling: "mean"; normalize: true }) => Promise<number[][]>)
    | undefined;

  constructor(
    readonly modelId: string,
    dims: number,
  ) {
    this.dims = dims;
  }

  /** Load the model and create the pipeline. Called once at daemon startup. */
  async warmup(): Promise<void> {
    const pipe = await pipeline("feature-extraction", this.modelId);
    this.#extract = async (texts, options) => {
      const tensor = await pipe(texts, options);
      return tensor.tolist() as number[][];
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.#extract) {
      await this.warmup();
    }
    return this.#extract!(texts, {
      pooling: "mean",
      normalize: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Sidecar embedding: HTTP POST against a Python daemon (not built yet)
// ---------------------------------------------------------------------------

export class SidecarEmbeddingProvider implements EmbeddingProvider {
  readonly dims: number;

  constructor(
    readonly sidecarUrl: string,
    dims: number,
  ) {
    this.dims = dims;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.sidecarUrl}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts }),
    });

    if (!response.ok) {
      throw new Error(
        `Sidecar embed request failed (${response.status}): ${await response.text()}`,
      );
    }

    const body = (await response.json()) as { embeddings: number[][] };
    return body.embeddings;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEmbeddingProvider(cfg: MemoryConfig): EmbeddingProvider {
  if (cfg.embedding.provider === "sidecar") {
    if (!cfg.embedding.sidecarUrl) {
      throw new Error(
        "sidecarUrl is required when embedding provider is 'sidecar'",
      );
    }
    return new SidecarEmbeddingProvider(
      cfg.embedding.sidecarUrl,
      cfg.embeddingDims,
    );
  }

  return new LocalEmbeddingProvider(cfg.embeddingModel, cfg.embeddingDims);
}