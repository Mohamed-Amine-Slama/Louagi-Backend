import DataLoader from 'dataloader';

// Public driver loader. Used by ride listings, search results, and any path
// that exposes a driver to a third party (passenger looking at the driver
// of a ride they want to book). Deliberately excludes PII like plate_number,
// id_card_number, license_number. Sensitive fields go through
// driverSensitiveLoader, which is only used by self-views and admin paths.
export function createLoaders(sql) {
  return {
    driverLoader: new DataLoader(async (keys) => {
      const rows = await sql`
        select
          d.id,
          d.user_id,
          d.vehicle_brand,
          d.vehicle_model,
          d.seat_count,
          d.status,
          d.rating,
          d.trips_completed,
          u.full_name
        from public.drivers d
        left join public.users u on u.id = d.user_id
        where d.id in ${sql(keys)}
      `;
      const map = new Map(rows.map((r) => [r.id, r]));
      return keys.map((key) => map.get(key) || null);
    }),

    driverSensitiveLoader: new DataLoader(async (keys) => {
      const rows = await sql`
        select
          d.id,
          d.plate_number,
          d.id_card_number,
          d.license_number,
          d.payout_account
        from public.drivers d
        where d.id in ${sql(keys)}
      `;
      const map = new Map(rows.map((r) => [r.id, r]));
      return keys.map((key) => map.get(key) || null);
    }),

    passengerLoader: new DataLoader(async (keys) => {
      const rows = await sql`
        select id, full_name, role
        from public.users
        where id in ${sql(keys)}
      `;
      const map = new Map(rows.map((r) => [r.id, r]));
      return keys.map((key) => map.get(key) || null);
    }),

    passengerContactLoader: new DataLoader(async (keys) => {
      const rows = await sql`
        select id, full_name, role, email, phone_number
        from public.users
        where id in ${sql(keys)}
      `;
      const map = new Map(rows.map((r) => [r.id, r]));
      return keys.map((key) => map.get(key) || null);
    }),

    bookingLoader: new DataLoader(async (keys) => {
      const rows = await sql`
        select id, ride_id, user_id, seats_booked, total_price, status, booked_at, cancelled_at
        from public.reservations
        where ride_id in ${sql(keys)}
      `;
      const map = new Map();
      keys.forEach((k) => map.set(k, []));
      rows.forEach((r) => {
        if (map.has(r.ride_id)) map.get(r.ride_id).push(r);
      });
      return keys.map((key) => map.get(key));
    }),
  };
}
