import "./globals.css";
import { I18nProvider } from "../components/I18nProvider";

export const metadata = {
  title: "Brain Kingdom",
  description: "Hand-drawn local-first PvP quiz game"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <I18nProvider>
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
