
Refactor resolvers.js for query performance
You are refactoring a Node.js backend resolver file. The goal is to eliminate in-memory filtering and full table scans by pushing work down to the database. Do not change any resolver's external behavior, input shape, or return shape.
Make exactly these changes:

1. Replace joinedRides() with a parameterized version
The current joinedRides() fetches all rides unconditionally. Replace it with:
jsasync function joinedRides({ driverId, rideId, status } = {}) { ... }
Add these WHERE clauses to the SQL conditionally:

and r.id = ${rideId}::uuid when rideId is provided
and d.user_id = ${driverId}::uuid when driverId is provided
and r.status = ${status}::ride_status when status is provided

Update every call site:

GetRideDetail({ rideId }) → joinedRides({ rideId })
DriverRides({ status }) → joinedRides({ driverId: actor.id, status })
AdminListRides({ filters }) → joinedRides({ status: filters.status, driverId: filters.driverId })
AvailableDeliveryRides({ origin, destination }) → joinedRides({ status: 'scheduled' })

Remove the JS-side .filter() calls on those results that now duplicate what the DB does.

2. Fix GetRideDetail — single row query
Currently calls joinedRides() and does rows.find(r => r.ride_id === rideId). After the above change it will still fetch one row, but make sure it returns rows[0] directly rather than using .find().

3. Fix AdminSearchUsers — push text search to SQL
Replace the current approach (fetch all users, filter in JS) with a SQL WHERE clause:
sqlwhere (
  ${query}::text is null
  or u.full_name ilike ${'%' + query + '%'}
  or u.email ilike ${'%' + query + '%'}
  or u.phone_number ilike ${'%' + query + '%'}
)
Keep the existing withTimeout wrapper. Remove the JS-side .filter() call entirely.

4. Fix DriverEarnings — join payments in SQL
Currently fetches all rides for the driver, then separately fetches all payments in the system and builds a Map in JS. Replace with a single joined query scoped to the driver:
sqlselect
  r.*,
  rt.origin_city,
  rt.destination_city,
  coalesce(sum(p.amount - coalesce(p.platform_fee, 0)) filter (where p.status = 'succeeded'), 0) as net_revenue
from public.rides r
join public.routes rt on rt.id = r.route_id
left join public.reservations res on res.ride_id = r.id
left join public.payments p on p.reservation_id = res.id
where r.driver_id = ${driver.id}::uuid
group by r.id, rt.id
Replace all uses of revenueByRide.get(ride.id) with Number(ride.net_revenue). Remove the separate payments query and the revenueByRide Map entirely.

Constraints:

Do not rename or move any resolver
Do not change any resolver's return shape
Do not add new dependencies
Do not modify any auth, validation, or audit logic
After changes, all existing call sites must still work identically