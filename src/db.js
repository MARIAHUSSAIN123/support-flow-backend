import mongoose from "mongoose";

// Cached connection so Vercel's serverless functions reuse it across
// invocations instead of opening a new MongoDB connection every request.
let cached = global._sfMongooseConn;
if (!cached) cached = global._sfMongooseConn = { conn: null, promise: null };

export async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    cached.promise = mongoose.connect(process.env.MONGODB_URI).then((m) => m);
  }
  cached.conn = await cached.promise;
  return cached.conn;
}
