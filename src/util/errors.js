function userError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
module.exports = { userError };
