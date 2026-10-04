import { gql, type TypedDocumentNode } from "@apollo/client";
import type { Queue } from "./queue-types";

export const QUEUE: TypedDocumentNode<{ queue: Queue }> = gql`
  subscription Queue { queue { open } }
`;
