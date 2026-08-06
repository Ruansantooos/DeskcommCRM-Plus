/**
 * Cliente da Google Places API (Text Search v1) — EPIC-14.
 *
 * Field mask explícito e enxuto: a Places cobra por campo pedido, não só por
 * request. Pedir tudo multiplica a conta do self-hoster sem melhorar o lead.
 *
 * `websiteUri` e `nationalPhoneNumber` vêm de graça nesta mesma chamada — é o
 * que faz o enriquecimento começar já com meio caminho andado (PRD D-02).
 */
import { env } from "@/lib/env";

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.primaryType",
  "places.location",
  "nextPageToken",
].join(",");

export interface PlaceResult {
  place_id: string;
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  category: string | null;
  lat: number | null;
  lng: number | null;
}

interface RawPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  primaryType?: string;
  location?: { latitude?: number; longitude?: number };
}

export class PlacesError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PlacesError";
  }
}

export function placesConfigured(): boolean {
  return env.GOOGLE_PLACES_API_KEY.trim().length > 0;
}

/**
 * Busca textual paginada. Para ao atingir `limite` — que é teto de custo, não
 * sugestão de tamanho de página.
 */
export async function searchPlaces(opts: {
  nicho: string;
  cidade: string;
  raioKm: number;
  limite: number;
}): Promise<PlaceResult[]> {
  const key = env.GOOGLE_PLACES_API_KEY.trim();
  if (!key) throw new PlacesError("GOOGLE_PLACES_API_KEY ausente.", 0);

  const out: PlaceResult[] = [];
  let pageToken: string | undefined;

  while (out.length < opts.limite) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Chave em header, nunca em query string — query string vaza em log de
        // proxy/CDN (regra 12 dos anti-patterns).
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: `${opts.nicho} em ${opts.cidade}`,
        languageCode: "pt-BR",
        regionCode: "BR",
        maxResultCount: Math.min(20, opts.limite - out.length),
        ...(pageToken ? { pageToken } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new PlacesError(
        `Google Places respondeu ${res.status}. ${body.slice(0, 200)}`,
        res.status,
      );
    }

    const json = (await res.json()) as { places?: RawPlace[]; nextPageToken?: string };

    for (const p of json.places ?? []) {
      if (!p.id) continue;
      out.push({
        place_id: p.id,
        name: p.displayName?.text ?? "(sem nome)",
        address: p.formattedAddress ?? null,
        phone: p.nationalPhoneNumber ?? null,
        website: p.websiteUri ?? null,
        category: p.primaryType ?? null,
        lat: p.location?.latitude ?? null,
        lng: p.location?.longitude ?? null,
      });
      if (out.length >= opts.limite) break;
    }

    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }

  return out;
}
