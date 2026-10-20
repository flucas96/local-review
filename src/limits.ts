/** Shared field limits used before persistence and when reading transport data. */
export const maximumReviewTextLength = 200_000;
export const maximumReplyLength = 20_000;
export const maximumPathLength = 4096;
export const maximumIdentifierLength = 256;

/** Keep quoted discussion bounded while the current event carries the full request. */
export const maximumConversationMessages = 20;
export const maximumConversationTextLength = 100_000;
