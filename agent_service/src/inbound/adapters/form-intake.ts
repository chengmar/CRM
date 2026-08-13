import { z } from "zod";
import {
  normalizeInboundIntake,
  normalizedInboundIntakeSchema,
  type NormalizedInboundIntake,
} from "../../acquisition/inbound-intake.js";
import type { InboundIntakeAdapter } from "../intake.js";

const formInputSchema = normalizedInboundIntakeSchema
  .omit({ source: true })
  .extend({ source: z.literal("FORM").optional() })
  .strict();

export class FormInboundIntakeAdapter implements InboundIntakeAdapter {
  readonly source = "FORM" as const;

  async normalize(input: unknown): Promise<NormalizedInboundIntake> {
    const parsed = formInputSchema.parse(input);
    return normalizeInboundIntake({ ...parsed, source: this.source });
  }
}
