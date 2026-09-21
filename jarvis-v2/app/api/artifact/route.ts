import {artifactResponse} from '@/lib/artifact-proxy';
export const dynamic='force-dynamic';
export const GET=(request:Request)=>artifactResponse(request);
