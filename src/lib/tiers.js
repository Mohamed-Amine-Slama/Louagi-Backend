// Loyalty points formula.
//
// The tier → discount ladder is NOT here anymore — it lives in the public.tiers
// catalogue (seeded via supabase/seed.sql) and is read directly by GetProfile
// (ListTiers / discount lookup) and by public.create_reservation when pricing a
// booking. Only the points formula stays in code, since it's a rule over
// reservation history rather than catalogue data.

// Louagi loyalty points: 100 per confirmed trip + 1 per TND spent.
export function loyaltyPoints({ trips = 0, spent = 0 } = {}) {
  return trips * 100 + Math.round(spent);
}
