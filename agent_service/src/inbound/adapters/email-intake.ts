import { z } from "zod";
import {
  normalizeInboundIntake,
  normalizedInboundIntakeSchema,
  type NormalizedInboundIntake,
} from "../../acquisition/inbound-intake.js";
import type { InboundIntakeAdapter } from "../intake.js";

const emailInputSchema = normalizedInboundIntakeSchema
  .omit({ source: true })
  .extend({ source: z.literal("EMAIL").optional() })
  .strict();

export class EmailInboundIntakeAdapter implements InboundIntakeAdapter {
  readonly source = "EMAIL" as const;

  async normalize(input: unknown): Promise<NormalizedInboundIntake> {
    const parsed = emailInputSchema.parse(input);
    return normalizeInboundIntake({ ...parsed, source: this.source });
  }
}
