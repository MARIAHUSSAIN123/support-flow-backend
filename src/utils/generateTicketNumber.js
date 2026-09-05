export function generateTicketNumber() {
  const year = new Date().getFullYear();
  const rand = Math.floor(1000 + Math.random() * 9000);
  const ts = Date.now().toString().slice(-5);
  return `SF-${year}-${ts}${rand}`;
}
