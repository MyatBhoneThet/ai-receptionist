import './globals.css';

export const metadata = {
    title: 'AI Receptionist',
    description: 'Voice & text AI receptionist for hotel and restaurant bookings',
};

export default function RootLayout({ children }) {
    return (
        <html lang="en" className="scroll-smooth">
            <body className="selection:bg-primary-500/30">
                {children}
            </body>
        </html>
    );
}
