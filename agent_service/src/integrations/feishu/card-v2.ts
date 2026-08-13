export type FeishuCardButtonType =
  | "default"
  | "primary"
  | "danger"
  | "primary_filled"
  | "danger_filled";

export interface FeishuCardButtonOptions {
  text: string;
  value: Record<string, unknown>;
  type?: FeishuCardButtonType;
  elementId?: string;
  confirm?: {
    title: string;
    text: string;
  };
}

/** Build a callback button for Feishu card JSON 2.0. */
export function cardV2Button(options: FeishuCardButtonOptions): object {
  return {
    tag: "button",
    ...(options.elementId ? { element_id: options.elementId } : {}),
    type: options.type ?? "default",
    size: "medium",
    width: "fill",
    text: { tag: "plain_text", content: options.text },
    ...(options.confirm
      ? {
          confirm: {
            title: { tag: "plain_text", content: options.confirm.title },
            text: { tag: "plain_text", content: options.confirm.text },
          },
        }
      : {}),
    behaviors: [{ type: "callback", value: options.value }],
  };
}

export function cardV2Buttons(options: FeishuCardButtonOptions[]): object[] {
  return options.map(cardV2Button);
}
