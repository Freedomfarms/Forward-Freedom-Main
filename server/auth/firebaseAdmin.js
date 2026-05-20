import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

function normalizePrivateKey(value = "") {
  return value.replace(/\\n/g, "\n");
}

function buildServiceAccount() {
  const json = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON;
  if (json) {
    const parsed = JSON.parse(json);
    return {
      projectId: parsed.project_id || parsed.projectId,
      clientEmail: parsed.client_email || parsed.clientEmail,
      privateKey: normalizePrivateKey(parsed.private_key || parsed.privateKey || ""),
    };
  }

  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = normalizePrivateKey(process.env.FIREBASE_ADMIN_PRIVATE_KEY || "");

  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }

  return {
    projectId,
    clientEmail,
    privateKey,
  };
}

export function isFirebaseAdminConfigured() {
  return Boolean(buildServiceAccount());
}

export function getFirebaseAdminApp() {
  if (!isFirebaseAdminConfigured()) {
    return null;
  }

  return getApps()[0] || initializeApp({ credential: cert(buildServiceAccount()) });
}

export function getFirebaseAdminAuth() {
  const app = getFirebaseAdminApp();
  return app ? getAuth(app) : null;
}
