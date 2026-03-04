import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { createUser, findUserById, findUserByUsername } from './userDb.js';

const SALT_ROUNDS = 12;

export async function registerUser(username, password) {
  if (!username || !password) {
    throw new Error('Username and password required');
  }
  if (findUserByUsername(username)) {
    throw new Error('Username already exists');
  }
  const passhash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = createUser(username, passhash);
  const token = issueToken(user);
  return { user, token };
}

export async function loginUser(username, password) {
  const user = findUserByUsername(username);
  if (!user) {
    throw new Error('Invalid credentials');
  }
  const ok = await bcrypt.compare(password, user.passhash);
  if (!ok) {
    throw new Error('Invalid credentials');
  }
  return { user, token: issueToken(user) };
}

export async function verifyUserPassword(userId, password) {
  const user = findUserById(userId);
  if (!user) return false;
  return bcrypt.compare(password, user.passhash);
}

function issueToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn
  });
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}
