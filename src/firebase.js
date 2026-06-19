import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  projectId: "roomiebet-2026-mcm",
  appId: "1:748284716767:web:c760bdbf996a17413e6b6a",
  storageBucket: "roomiebet-2026-mcm.firebasestorage.app",
  apiKey: "AIzaSyBfzmfZvpA09gyXBcAg0mbmNwSqy4s6IAA",
  authDomain: "roomiebet-2026-mcm.firebaseapp.com",
  messagingSenderId: "748284716767"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };
