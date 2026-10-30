import { Box, Text } from '../ink.js'
import { AMBER, CRIMSON, IVORY, SAND, TEAL } from './mercuryPalette.js'

export function MercuryApiKey({apiKey='sk-ant-…a1b2'}:{apiKey?:string}){return (
  <Box flexDirection="column" borderStyle="round" borderColor={AMBER} paddingX={1}>
    <Text><Text color={AMBER}>{'⦿'}</Text> <Text bold color={IVORY}>Approve API key?</Text></Text>
    <Text color={SAND}>{apiKey}</Text>
    <Text><Text color={TEAL}>[y]</Text> use  <Text color={CRIMSON}>[n]</Text> reject</Text>
  </Box>)}
