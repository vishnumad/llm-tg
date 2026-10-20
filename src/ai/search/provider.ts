export type SearchOptions = {
  topic?: "general" | "news";
  timeRange?: "day" | "week" | "month" | "year";
};

export type SearchResult = {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
};

export type SearchResponse = {
  /** Text the backend wrote itself, for backends that summarize. */
  answer?: string;
  results: SearchResult[];
};

export type PageContent = {
  url: string;
  title?: string;
  content: string;
};

export type ReadResponse = {
  answer?: string;
  pages: PageContent[];
  failed: { url: string; error: string }[];
};

export interface SearchProvider {
  name: string;
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
  read(urls: string[], question?: string): Promise<ReadResponse>;
}
