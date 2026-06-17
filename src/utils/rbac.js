const matrix = {
  'rides:book': ['passenger'],
  'rides:create': ['driver'],
  'rides:manage': ['driver', 'admin'],
  'location:update': ['driver'],
  'admin:read': ['admin'],
  'admin:verify-driver': ['admin'],
  'admin:suspend-user': ['admin'],
  'admin:refund': ['admin'],
  'admin:impersonate': ['admin'],
  'profile:self': ['passenger', 'driver', 'admin'],
};

export function can(role, action) {
  return matrix[action]?.includes(role) ?? false;
}
