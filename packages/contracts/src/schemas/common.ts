import { z } from "zod";

export const UuidSchema = z.string().uuid();
export const UlidSchema = z.string().length(26).regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
