export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 8080),
  // 'manager' (Managed mode) or 'controller' (Controlled/performance mode).
  // See spec section 1, "Operating modes".
  serverRole: process.env.SERVER_ROLE ?? 'manager',
};
