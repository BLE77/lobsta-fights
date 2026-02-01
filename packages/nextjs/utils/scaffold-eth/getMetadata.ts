import type { Metadata } from "next";

export function getMetadata({
  title,
  description,
  image,
}: {
  title: string;
  description: string;
  image: string;
}): Metadata {
  return {
    title,
    description,
    icons: {
      icon: "/favicon.svg",
    },
    openGraph: {
      title,
      description,
      images: [{ url: image }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}