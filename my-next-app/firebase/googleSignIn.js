import { GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import { auth } from "./config";

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  try {
    const result = await signInWithPopup(auth, provider);
    return result.user; 
  } catch (error) {
    console.error("Google sign-in error:", error);
    return null;
  }
}
