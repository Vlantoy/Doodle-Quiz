import "./globals.css";

export const metadata = {
  title: "Brain Kingdom",
  description: "Hand-drawn local-first PvP quiz game"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
