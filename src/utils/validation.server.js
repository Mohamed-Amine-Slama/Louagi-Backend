import { z } from 'zod';

export const BookRideSchema = z.object({
  rideId: z.string().uuid("Invalid ride ID format"),
  seatsCount: z.number().int().min(1).max(4, "You can book up to 4 seats maximum")
});

export const SearchSchema = z.object({
  origin: z.string().min(2, "Origin must be at least 2 characters").max(50, "Origin too long").optional().nullable().or(z.literal('')),
  destination: z.string().min(2, "Destination must be at least 2 characters").max(50, "Destination too long").optional().nullable().or(z.literal('')),
  date: z.union([z.string(), z.date()]).optional().nullable(),
  seats: z.number().int().min(1).max(8).optional().nullable().or(z.literal(null)),
  filters: z.object({
    priceMax: z.number().nullable().optional(),
    ratingMin: z.number().min(0).max(5).nullable().optional(),
    departureBefore: z.number().nullable().optional()
  }).optional().nullable(),
  sort: z.enum(['departure', 'price', 'rating']).optional().default('departure')
});

export const DeleteMessageSchema = z.object({
  messageId: z.string().uuid("Invalid message ID format"),
  forEveryone: z.boolean().default(false)
});

export const CreateRideSchema = z.object({
  origin: z.string().min(2).max(50).optional().nullable(),
  destination: z.string().min(2).max(50).optional().nullable(),
  routeId: z.string().uuid().optional().nullable(),
  departureTime: z.union([z.string(), z.date()]),
  // Accepted for backwards compat with older clients, but ignored — the server
  // forces `price_per_seat` to the government-set base_price.
  pricePerSeat: z.number().positive().optional(),
  availableSeats: z.number().int().min(1).max(8)
});
