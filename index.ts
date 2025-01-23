import { config } from "dotenv";
import {
  createWalletClient,
  createPublicClient,
  http,
  formatEther,
  parseEther,
  type Address,
  type Hex,
  getAddress,
  decodeAbiParameters,
  type WalletClient,
  type Transport,
  type Chain,
  type Account,
} from "viem";
import { abstractTestnet, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { eip712WalletActions } from "viem/zksync";
import fs from "fs";
import {
  Pool,
  Position,
  Route,
  SwapQuoter,
  nearestUsableTick,
  type MintOptions,
  NonfungiblePositionManager,
} from "@uniswap/v3-sdk";
import {
  CurrencyAmount,
  Percent,
  TradeType,
  Token as UniswapSdkCoreToken,
} from "@uniswap/sdk-core";
import { abstractTestnetBytecode, baseSepoliaBytecode } from "./bytecode.json";
import {
  factoryAbi,
  poolAbi,
  nonFungiblePositionManagerAbi,
  swapRouterAbi,
  simpleTokenAbi,
} from "./abis";

config();

const wantedChain = abstractTestnet;
const create = process.argv.includes("--create");

const simpleTokenBytecode =
  wantedChain.id === abstractTestnet.id
    ? (abstractTestnetBytecode as Hex)
    : (baseSepoliaBytecode as Hex);

const publicClient = createPublicClient({
  chain: wantedChain,
  transport: http(),
});

const contractAddress: Record<
  typeof abstractTestnet.name | typeof baseSepolia.name,
  {
    FACTORY_ADDRESS: Address;
    SWAP_ROUTER_ADDRESS: Address;
    NONFUNGIBLE_TOKEN_POSITION_MANAGER_ADDRESS: Address;
    WETH_ADDRESS: Address;
    QUOTER_V2_ADDRESS: Address;
  }
> = {
  [abstractTestnet.name]: {
    FACTORY_ADDRESS: "0x2E17FF9b877661bDFEF8879a4B31665157a960F0",
    SWAP_ROUTER_ADDRESS: "0xb9D4347d129a83cBC40499Cd4fF223dE172a70dF",
    NONFUNGIBLE_TOKEN_POSITION_MANAGER_ADDRESS:
      "0x069f199763c045A294C7913E64bA80E5F362A5d7",
    WETH_ADDRESS: "0x9EDCde0257F2386Ce177C3a7FCdd97787F0D841d",
    QUOTER_V2_ADDRESS: "0xdE41045eb15C8352413199f35d6d1A32803DaaE2",
  },

  [baseSepolia.name]: {
    FACTORY_ADDRESS: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    SWAP_ROUTER_ADDRESS: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
    NONFUNGIBLE_TOKEN_POSITION_MANAGER_ADDRESS:
      "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2",
    WETH_ADDRESS: "0x4200000000000000000000000000000000000006",
    QUOTER_V2_ADDRESS: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
  },
};

type Token = {
  address: Address;
  tokenName: string;
  tokenSymbol: string;
  tokenSupply: bigint;
};

const token_one_name = "Pudgy";
const token_one_symbol = "PUDGY";
const token_one_supply = parseEther("1000");

const token_two_name = "Penguin";
const token_two_symbol = "PENGUIN";
const token_two_supply = parseEther("1000");

const pool_fee = 500;

const CACHE_FILE = "cache.json";

let cache: any = {};
if (!fs.existsSync(CACHE_FILE)) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify({}));
}
cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));

function saveCache(data: any) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

function formatHashLink(hash: string): string {
  return `${wantedChain.blockExplorers.default.url}/tx/${hash}`;
}

type MyWalletClient = WalletClient<Transport, Chain, any, any>;

const deployToken = async (
  client: MyWalletClient,
  account: Account,
  tokenName: string,
  tokenSymbol: string,
  tokenSupply: bigint,
): Promise<Token> => {
  const hash = await client.deployContract({
    account,
    abi: simpleTokenAbi,
    args: [tokenName, tokenSymbol, tokenSupply],
    bytecode: simpleTokenBytecode,
    chain: wantedChain,
  });

  console.log(
    `Token ${tokenName} deployed at: ${wantedChain.blockExplorers.default.url}/tx/${hash}`,
  );
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
  });
  const tokenContractAddress = receipt.contractAddress;
  if (!tokenContractAddress) {
    throw new Error("Contract address is not defined");
  }
  return {
    address: tokenContractAddress,
    tokenName,
    tokenSymbol,
    tokenSupply,
  };
};

async function createPool(
  walletClient: MyWalletClient,
  account: Account,
  tokenOne: Token,
  tokenTwo: Token,
  wantedContracts: (typeof contractAddress)[typeof abstractTestnet.name],
): Promise<{ poolAddress: Address; initHash: Hex }> {
  console.log("deploying pool...");
  const hash = await walletClient.writeContract({
    address: wantedContracts.FACTORY_ADDRESS,
    abi: factoryAbi,
    args: [tokenOne.address, tokenTwo.address, pool_fee],
    account,
    chain: wantedChain,
    functionName: "createPool",
  });

  console.log(
    `Pool created at tx: ${wantedChain.blockExplorers.default.url}/tx/${hash}`,
  );

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  let poolAddress: Address;
  if (receipt.contractAddress) {
    poolAddress = receipt.contractAddress;
  } else if (receipt.logs[0]?.data) {
    poolAddress = getAddress("0x" + receipt.logs[0].data.slice(-40)) as Address;
  } else {
    throw new Error("Pool address is not defined");
  }

  console.log(
    `Pool has contract address: ${wantedChain.blockExplorers.default.url}/address/${poolAddress}`,
  );

  const startingPrice = 1n; // 1:1 price ratio
  const sqrtPriceX96 = BigInt(
    Math.floor(Math.sqrt(Number(startingPrice)) * 2 ** 96),
  );
  const nonce = await publicClient.getTransactionCount({
    address: account.address,
  });

  console.log("initializing pool...");

  const initHash = await walletClient.writeContract({
    address: wantedContracts.NONFUNGIBLE_TOKEN_POSITION_MANAGER_ADDRESS,
    abi: nonFungiblePositionManagerAbi,
    functionName: "createAndInitializePoolIfNecessary",
    args: [tokenOne.address, tokenTwo.address, pool_fee, sqrtPriceX96],
    account,
    chain: wantedChain,
    nonce,
  });

  console.log(
    `Initializing pool, tx: ${wantedChain.blockExplorers.default.url}/tx/${initHash}`,
  );

  await publicClient.waitForTransactionReceipt({ hash: initHash });

  return { poolAddress, initHash };
}

async function giveAllowances(
  walletClient: MyWalletClient,
  account: Account,
  tokens: Token[],
  contracts: Address[],
  chain: Chain,
): Promise<void> {
  console.log("checking allowances...");
  for (const token of tokens) {
    for (const contract of contracts) {
      const allowance = await publicClient.readContract({
        address: token.address,
        abi: simpleTokenAbi,
        functionName: "allowance",
        args: [account.address, contract],
      });

      if (allowance === 0n) {
        console.log(
          `Allowance for ${token.tokenSymbol} is not set, approving...`,
        );
        const hash = await walletClient.writeContract({
          address: token.address,
          abi: simpleTokenAbi,
          functionName: "approve",
          args: [contract, token.tokenSupply], // Max approval
          account,
          chain,
        });

        console.log(
          `Approval tx for ${token.address} and ${contract}: ${hash}`,
        );

        await publicClient.waitForTransactionReceipt({ hash });
        console.log(`Approval confirmed for ${token.tokenSymbol}`);
      }
    }
  }
}

const main = async () => {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("Private key is not defined in the environment variables");
  }

  const account = privateKeyToAccount(`0x${process.env.PRIVATE_KEY}`);

  let tokenOne = (
    cache.tokenOne
      ? {
          ...cache.tokenOne,
          tokenSupply: parseEther(cache.tokenOne.tokenSupply),
        }
      : undefined
  ) as Token;
  let tokenTwo = (
    cache.tokenTwo
      ? {
          ...cache.tokenTwo,
          tokenSupply: parseEther(cache.tokenTwo.tokenSupply),
        }
      : undefined
  ) as Token;
  let poolAddress = cache.poolAddress as Address;
  const wantedContracts = contractAddress[wantedChain.name];

  let walletClient: MyWalletClient =
    wantedChain.id === abstractTestnet.id
      ? createWalletClient({
          chain: wantedChain,
          transport: http(),
        }).extend(eip712WalletActions())
      : createWalletClient({
          chain: wantedChain,
          transport: http(),
        });

  const ethBalance = await publicClient.getBalance({
    address: account.address,
  });
  console.log("Eth balance:", formatEther(ethBalance));

  if (ethBalance === 0n) {
    throw new Error("No ETH balance. Cant deploy");
  }

  if (create || !tokenOne || !tokenTwo) {
    console.log("deploying tokens...");

    tokenOne = await deployToken(
      walletClient,
      account,
      token_one_name,
      token_one_symbol,
      token_one_supply,
    );
    tokenTwo = await deployToken(
      walletClient,
      account,
      token_two_name,
      token_two_symbol,
      token_two_supply,
    );

    [tokenOne, tokenTwo] =
      tokenOne.address.toLowerCase() < tokenTwo.address.toLowerCase()
        ? [tokenOne, tokenTwo]
        : [tokenTwo, tokenOne];

    const newPool = await createPool(
      walletClient,
      account,
      tokenOne,
      tokenTwo,
      wantedContracts,
    );
    poolAddress = newPool.poolAddress;

    saveCache({
      tokenOne: {
        ...tokenOne,
        tokenSupply: String(tokenOne.tokenSupply),
      },
      tokenTwo: {
        ...tokenTwo,
        tokenSupply: String(tokenTwo.tokenSupply),
      },
      poolAddress,
    });
  }

  const tokens = [tokenOne, tokenTwo];
  const contracts = [
    wantedContracts.NONFUNGIBLE_TOKEN_POSITION_MANAGER_ADDRESS,
    wantedContracts.SWAP_ROUTER_ADDRESS,
  ];

  await giveAllowances(walletClient, account, tokens, contracts, wantedChain);

  [tokenOne, tokenTwo] =
    tokenOne.address.toLowerCase() < tokenTwo.address.toLowerCase()
      ? [tokenOne, tokenTwo]
      : [tokenTwo, tokenOne];

  const [tickSpacing, fee, liquidity, slot0] = await Promise.all([
    publicClient.readContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "tickSpacing",
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "fee",
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "liquidity",
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "slot0",
    }),
  ]);
  const sqrtPriceX96 = slot0[0];
  const tick = slot0[1];

  const TokenOneUniswapSdkCore = new UniswapSdkCoreToken(
    abstractTestnet.id,
    tokenOne.address,
    18,
    tokenOne.tokenName,
    tokenOne.tokenSymbol,
  );

  const TokenTwoUniswapSdkCore = new UniswapSdkCoreToken(
    abstractTestnet.id,
    tokenTwo.address,
    18,
    tokenTwo.tokenName,
    tokenTwo.tokenSymbol,
  );

  const pool = new Pool(
    TokenOneUniswapSdkCore,
    TokenTwoUniswapSdkCore,
    fee,
    sqrtPriceX96.toString(),
    liquidity.toString(),
    tick,
  );

  console.log("adding liquidity...");
  const position = new Position({
    pool: pool,
    liquidity: parseEther("500").toString(),
    tickLower: nearestUsableTick(tick, tickSpacing) - tickSpacing * 2,
    tickUpper: nearestUsableTick(tick, tickSpacing) + tickSpacing * 2,
  });

  const mintOptions: MintOptions = {
    recipient: account.address,
    deadline: Math.floor(Date.now() / 1000) + 60 * 20,
    slippageTolerance: new Percent(5, 10_000), // high slippage
  };

  let { calldata, value } = NonfungiblePositionManager.addCallParameters(
    position,
    mintOptions,
  );

  let nonce = await publicClient.getTransactionCount({
    address: account.address,
  });

  const request = await walletClient.prepareTransactionRequest({
    account,
    data: calldata as `0x${string}`,
    to: wantedContracts.NONFUNGIBLE_TOKEN_POSITION_MANAGER_ADDRESS,
    value: BigInt(value),
    nonce,
  });

  const serializedTransaction = await walletClient.signTransaction(request);

  const mintHash = await walletClient.sendRawTransaction({
    serializedTransaction,
  });

  await publicClient.waitForTransactionReceipt({
    hash: mintHash,
  });

  console.log(
    `liquidity added at tx: ${wantedChain.blockExplorers.default.url}/tx/${mintHash}`,
  );

  const tokensIn = TokenOneUniswapSdkCore;
  const tokensOut = TokenTwoUniswapSdkCore;
  const swapRoute = new Route([pool], tokensIn, tokensOut);

  const inputAmount = CurrencyAmount.fromRawAmount(
    tokensIn,
    String(parseEther(String(parseEther("1")))), // TODO fix this ugly shit
  );
  console.log("inputAmount", inputAmount.quotient.toString());

  const quote = await SwapQuoter.quoteCallParameters(
    swapRoute,
    inputAmount,
    TradeType.EXACT_INPUT,
    {
      useQuoterV2: true,
    },
  );

  const quoteCallReturnData = await publicClient.call({
    to: wantedContracts.QUOTER_V2_ADDRESS,
    data: quote.calldata as `0x${string}`,
  });

  if (!quoteCallReturnData.data) {
    throw new Error("Quote call return data is not defined");
  }

  const [amountIn] = decodeAbiParameters(
    [{ type: "uint256" }],
    quoteCallReturnData.data,
  );

  nonce = await publicClient.getTransactionCount({
    address: account.address,
  });

  console.log(
    `swapping ${formatEther(amountIn)} ${tokensIn.symbol} to ${tokensOut.symbol}...`,
  );
  const swapHash = await walletClient.writeContract({
    address: wantedContracts.SWAP_ROUTER_ADDRESS,
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: tokensIn.address as `0x${string}`,
        tokenOut: tokensOut.address as `0x${string}`,
        recipient: account.address,
        amountIn: amountIn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
        fee: pool_fee,
      },
    ],
    nonce,
    account,
    chain: wantedChain,
  });

  console.log(
    `swap hash: ${wantedChain.blockExplorers.default.url}/tx/${swapHash}`,
  );
  await publicClient.waitForTransactionReceipt({
    hash: swapHash,
  });

  console.log("swap completed! 🤙");
};
main();
