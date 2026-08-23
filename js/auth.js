// ============================================================================
//  Authenticatie (Firebase Auth - Email/Password)
// ============================================================================

import { auth } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

/** Log een bandlid in met e-mail en wachtwoord. */
export function login(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

/** Maak een nieuw account aan (handig voor het toevoegen van bandleden). */
export function register(email, password) {
  return createUserWithEmailAndPassword(auth, email, password);
}

/** Log de huidige gebruiker uit. */
export function logout() {
  return signOut(auth);
}

/** Roep de callback aan bij elke wijziging van de inlogstatus. */
export function watchAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

/** Vertaal Firebase Auth-foutcodes naar begrijpelijke Nederlandse teksten. */
export function friendlyAuthError(code) {
  const map = {
    "auth/invalid-email": "Ongeldig e-mailadres.",
    "auth/user-disabled": "Dit account is uitgeschakeld.",
    "auth/user-not-found": "Geen account gevonden met dit e-mailadres.",
    "auth/wrong-password": "Onjuist wachtwoord.",
    "auth/invalid-credential": "Onjuiste inloggegevens.",
    "auth/email-already-in-use": "Dit e-mailadres is al in gebruik.",
    "auth/weak-password": "Wachtwoord moet minimaal 6 tekens zijn.",
    "auth/too-many-requests": "Te veel pogingen. Probeer het later opnieuw.",
  };
  return map[code] || "Er ging iets mis. Probeer het opnieuw.";
}
