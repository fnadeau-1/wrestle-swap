// firebase/config.js
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyBrNzOA__bI6zA2PvTFTujmFiBLsCe1iBk",
  authDomain: "wrestleswap.firebaseapp.com",
  projectId: "wrestleswap",
  storageBucket: "wrestleswap.firebasestorage.app",
  messagingSenderId: "857051782398",
  appId: "1:857051782398:web:bb4ab3f98e8dbbc8cad9af",
  measurementId: "G-B411WXLF3J"

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
