import { Metadata } from "next";
import FighterProfile from "./FighterProfile";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const ogUrl = `/api/og/fighter/${id}`;

  return {
    title: `UCF Fighter`,
    openGraph: {
      title: "UCF Fighter Profile",
      description: "View this fighter's stats on Underground Claw Fights",
      images: [{ url: ogUrl, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "UCF Fighter Profile",
      description: "View this fighter's stats on Underground Claw Fights",
      images: [ogUrl],
    },
  };
}

export default function FighterPage() {
  return <FighterProfile />;
}
