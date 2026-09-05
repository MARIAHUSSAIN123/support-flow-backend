import mongoose from "mongoose";

// Cached connection so Vercel's serverless functions reuse it across
// invocations instead of opening a new MongoDB connection every request.
let cached = global._sfMongooseConn;
if (!cached) cached = global._sfMongooseConn = { conn: null, promise: null };

function connectOnce() {
  return mongoose.connect(process.env.MONGODB_URI, {
    // Fail fast on a genuinely dead connection instead of hanging until
    // the whole serverless function is killed.
    serverSelectionTimeoutMS: 8000,
    socketTimeoutMS: 20000,
    maxPoolSize: 5,
    bufferCommands: false,
  });
}

export async function connectDB() {
  if (cached.conn) {
    // mongoose keeps this in sync; readyState 1 = connected.
    if (mongoose.connection.readyState === 1) return cached.conn;
    cached.conn = null;
    cached.promise = null;
  }

  if (!cached.promise) {
    cached.promise = connectOnce().catch(async (err) => {
      // First attempt on a cold serverless instance sometimes loses the
      // race against Atlas waking up / DNS warming up. One quick retry
      // clears the vast majority of these without the user ever seeing it.
      cached.promise = null;
      await new Promise((r) => setTimeout(r, 400));
      return connectOnce();
    });
  }

  try {
    cached.conn = await cached.promise;
    return cached.conn;
  } catch (err) {
    cached.promise = null;
    throw err;
  }
}
