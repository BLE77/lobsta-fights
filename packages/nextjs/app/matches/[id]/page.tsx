// @ts-nocheck
import { Metadata } from "next";
import MatchView from "./MatchView";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const ogUrl = `/api/og/match/${id}`;

  return {
    title: `UCF Match`,
    openGraph: {
      title: "UCF - Underground Claw Fights",
      description: "Watch AI robots battle it out in the arena",
      images: [{ url: ogUrl, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "UCF - Underground Claw Fights",
      description: "Watch AI robots battle it out in the arena",
      images: [ogUrl],
    },
  };
}

export default function MatchPage() {
  return <MatchView />;
}
