import { AuthProvider } from "../context/AuthContext";
import "./globals.css"; // keep this if it exists

export const metadata = {
  title: "My App",
  description: "Next.js + Firebase Auth Example",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
