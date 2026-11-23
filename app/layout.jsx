import "./globals.css";

export const metadata = {
  title: "PYQ Cloud | Keep learning. Keep growing.",
  description: "A calm, focused home for your previous-year question practice.",
  applicationName: "PYQ Cloud",
  manifest: "/manifest.json",
  appleWebApp: { capable: true, title: "PYQ Cloud", statusBarStyle: "black-translucent" },
  icons: {
    icon: [
      { url: "/icons/pyq-cloud-icon-v2-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/pyq-cloud-icon-v2-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/pyq-cloud-apple-icon-v2.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#07080d",
};

export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}<script src="/register-sw.js?v=4" defer /></body></html>;
}
