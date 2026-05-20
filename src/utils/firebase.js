import { getApp, getApps, initializeApp } from "firebase/app";
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
} from "firebase/auth";

const firebaseClientConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
};

const REQUIRED_FIREBASE_KEYS = ["apiKey", "authDomain", "projectId", "appId"];

let persistenceSetupPromise = null;

export function getFirebaseClientConfig() {
  const missingKeys = REQUIRED_FIREBASE_KEYS.filter((key) => !firebaseClientConfig[key]);

  return {
    ...firebaseClientConfig,
    configured: missingKeys.length === 0,
    missingKeys,
  };
}

function getFirebaseAppInstance() {
  const config = getFirebaseClientConfig();
  if (!config.configured) return null;

  return getApps().length ? getApp() : initializeApp(firebaseClientConfig);
}

export function getFirebaseAuthInstance() {
  const app = getFirebaseAppInstance();
  if (!app) return null;

  const auth = getAuth(app);
  if (!persistenceSetupPromise) {
    persistenceSetupPromise = setPersistence(auth, browserLocalPersistence).catch(() => null);
  }

  return auth;
}

async function getReadyFirebaseAuth() {
  const auth = getFirebaseAuthInstance();
  if (!auth) {
    throw new Error("Firebase authentication is not configured yet.");
  }

  if (persistenceSetupPromise) {
    await persistenceSetupPromise;
  }

  return auth;
}

function buildGoogleProvider() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({
    prompt: "select_account",
  });
  return provider;
}

export async function signInWithGooglePopup() {
  const auth = await getReadyFirebaseAuth();
  return signInWithPopup(auth, buildGoogleProvider());
}

export async function signInWithEmail({ email, password }) {
  const auth = await getReadyFirebaseAuth();
  return signInWithEmailAndPassword(auth, email, password);
}

export async function registerWithEmail({ email, password, displayName }) {
  const auth = await getReadyFirebaseAuth();
  const credentials = await createUserWithEmailAndPassword(auth, email, password);
  if (displayName?.trim()) {
    await updateProfile(credentials.user, { displayName: displayName.trim() });
  }

  return credentials;
}

export async function signOutCurrentUser() {
  const auth = await getReadyFirebaseAuth();
  return signOut(auth);
}

export async function getCurrentUserIdToken(forceRefresh = false) {
  const auth = await getReadyFirebaseAuth();
  if (!auth.currentUser) return null;
  return auth.currentUser.getIdToken(forceRefresh);
}

export { onAuthStateChanged };
