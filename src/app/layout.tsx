import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Epson Print Station — Utilitas Web ke Print",
  description:
    "Pratinjau presisi tinggi dan kontrol cetak untuk printer Epson EcoTank / L-Series: auto-fit kertas, grayscale real-time, duplex manual, dan mode spooler langsung.",
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23003399' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2'/><path d='M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6'/><rect x='6' y='14' width='12' height='8' rx='1'/></svg>",
  },
};

export const viewport: Viewport = {
  themeColor: "#F4F5F7",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster position="bottom-right" closeButton />
      </body>
    </html>
  );
}
