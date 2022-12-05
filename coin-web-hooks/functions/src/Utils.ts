import * as ccxt from "ccxt";
import { firestore } from "firebase-admin";
import * as functions from "firebase-functions";
import Telegram, {Telegram_ParseModes} from "./telegram";

export class CoinUtils {
    private nickName = "";
    private email = "";
    private apiKey = "";
    private secret = "";
    private exchange: ccxt.Exchange;
    private orderAmountbufferPercent = 0.99;
    private telegram: Telegram;

    constructor(nickName: string, email: string, apiKey: string, secret: string, type: 'upbit' | 'binance' | 'coinone' = 'upbit', options: Object = {}) {
        this.nickName = nickName;
        this.email = email;
        this.apiKey = apiKey;
        this.secret = secret;
        this.exchange = new ccxt[type]({
            'apiKey': this.apiKey,
            'secret': this.secret,
            'enableRateLimit': true,
            'options': options
        });
        this.telegram = new Telegram('5381986918:AAFrhOt-GP_tL5aXZ-XZR3LSpJGql3nWF_E');
    }

    getExchange () {
        return this.exchange;
    }

    parseSymbol (symbol: string): { name: string, currency: string, futureName: string } {
        const symbolToken = symbol.split('/');
        return { name: symbolToken[0], currency: symbolToken[1], futureName: symbol.replace('/', '') };
    }

    /**
     * 바이낸스 통신 에러 Error Message 처리
     * @param error 
     * @returns 
     */
    getErrorMessage(error: unknown) {
        if (error instanceof Error) return error.message;
        return String(error);
    }

    /**
     * 바이낸스 통신 에러시 텔레그램 메세지 전송
     * @param symbol 
     * @returns 
     */
    sendErrorMessage (msg : string) {
        const telegramReport = new Telegram('5165765010:AAGX6t4dC1FdE03uwLEhTp1wkVeo10UTMhY');

        telegramReport.send('48717538', msg, Telegram_ParseModes.MarkdownV2);
        // functions.logger.log(usersBalance);
        return true;
    }

    /**
     * stoploss 배열을 가지고 원래 amt를 구하기
     * @param params 
     */
    getOriginAmtByTakeprofit (params: { currentAmt: number, currentIndex: number, amtPercents: number[] }): number {
        const { currentAmt, currentIndex, amtPercents } = params;

        const afterStoplossList = amtPercents.slice(0, currentIndex);
        const afterPercent = afterStoplossList.reduce(function add (sum, currentValue) {
            return sum + currentValue
        }, 0);
                
        const originAmt = currentAmt / (1 - (afterPercent / 100));
        const takeProfitAmt = parseFloat((originAmt * (amtPercents[currentIndex]/100)).toFixed(4));
        // functions.logger.log('currentAmt', currentAmt, 'currentamt', amtPercents[currentIndex], 'takeProfitAmt',takeProfitAmt, 'currentIndex',currentIndex, 'afterPercent',afterPercent, 'originAmt',originAmt);
        
        return currentAmt > takeProfitAmt ? takeProfitAmt : currentAmt;
    }

    async buy (symbol: string, param: any = { "type": "fiat" }): Promise<void> {
        const sObj = this.parseSymbol(symbol);
        const balances = await this.getExchange().fetchBalance(param);
        const currency = balances.info.balances.filter((b: any) => b.asset === sObj.currency).pop();
        const res = await this.getExchange().createMarketOrder(symbol, 'buy', 1, currency.free);

        // save log
        console.log(res);
    }
    async sell (symbol: string, param: any = { "type": "fiat" }): Promise<void> {
        const sObj = this.parseSymbol(symbol);
        const balances = await this.getExchange().fetchBalance(param);
        console.log(balances);
        const currency = balances.info.balances.filter((b: any) => b.asset === sObj.name).pop();
        console.log(currency);
        const res = await this.getExchange().createMarketOrder(symbol, 'sell', currency.free);

        // save log
        console.log(res);
    }

    /**
     * UP AND DOWN 거래하기 
     */
    async binanceUpDown (symbol: string, side: string): Promise<void> {
        const sObj = this.parseSymbol(symbol);
        console.log(sObj);

        // buy 인 경우 
        if ('buy' === side) {
            // DOWN이 있으면 판다.         
            await this.sell(`${sObj.name}DOWN/USDT`);
            // UP을 산다.
            await this.buy(`${sObj.name}UP/USDT`);
        }
        // sell 인 경우 
        else {
            // UP이 있으면 판다.
            await this.sell(`${sObj.name}UP/USDT`);
            // DOWN을 산다. 
            await this.buy(`${sObj.name}DOWN/USDT`);
        }
    }

    /**
     * 심볼에 해당하는 포지션 정보를 가져온다. 
     * @param symbol 코인심볼
     * @returns 포지션 객체
     */
    async myPosition (symbol: string): Promise<any> {
        const ex = this.exchange;
        const symObj = this.parseSymbol(symbol);
        let balance = await ex.fetchBalance();
        functions.logger.log('balance info', balance);
        let positions = balance.info.positions || [];
        let myPosition = positions.filter((p: any) => p.symbol === symObj.futureName).pop();
        functions.logger.log('myPosition info', myPosition);
        return myPosition;
    }

    /**
     * 익절
     * @param symbol 코인명
     * @param positionRef myPositions 참조
     * @param amtPercents 현재 물량의 n% 배열
     * @returns 
     */
    async takeProfit (params: {
        symbol: string,
        side: string,
        leverage: number,
        positionRef: firestore.DocumentReference,
        takeProfitObject: { amtPercents: number[], delayMinutes: number },
        cid: string
    }, isDebug: boolean = false): Promise<any> {
        const { symbol, side, leverage, positionRef, takeProfitObject } = params;
        // 거래소에서 내 포지션 정보를 가져온다.  
        const myPosition = await this.myPosition(symbol);
        let telegramMsg : string = '';

        // 거래소에서 현재가를 가져온다.
        let tiker = await this.getExchange().fetchTicker(symbol, { 'type': 'future' });
        const lastPrice = parseFloat(tiker.info.lastPrice);

        // 수익이 -2%까지 감수한다. -2%이하이면 익절 프로세스를 종료한다.
        const limitTakeProfitPrice : number = Math.abs(((parseFloat(myPosition.entryPrice) - lastPrice) / lastPrice ) * 100 * leverage);
        functions.logger.log('\u{1F44C} tiker info', tiker, limitTakeProfitPrice);
        functions.logger.log('\u{1F44C} myPosition info', myPosition);
        if (limitTakeProfitPrice < -2) {
            functions.logger.log(`\u{1F6AB} 수익이 -2%이하이면 익절을 할수 없다1. ${limitTakeProfitPrice} ${lastPrice} ${myPosition.entryPrice}`);
            return [false,telegramMsg];
        }

        // firebase에 있는 내 포지션 정보를 가져와서 익절 카운트를 가져온다. 
        const docRef = await positionRef.get();

        // 포지션이 없으면 익절을 할수 없다. 
        if (!docRef.exists) {
            functions.logger.log(params, `\u{1F6AB} 포지션이 없어서 익절을 할수 없다.`);
            return [false,telegramMsg];
        }

        const data = docRef.data();
        if (!data) {
            functions.logger.log(params, `\u{1F6AB} 포지션이 없어서 익절을 할수 없다.`);
            return [false,telegramMsg];
        }

        functions.logger.log(params, `\u{2139} 내포지션정보`, data);

        if (data.side !== side) {
            functions.logger.log(params, `\u{1F6AB} 포지션이 일치하지 않아서 익절을 할수 없다.`);
            return [false,telegramMsg];
        }

        if (takeProfitObject.delayMinutes) {
            const endTime = new Date().getTime();
            const startTime = data.createdAt.toDate().getTime();
            const diffTime = Math.floor((endTime - startTime) / 1000);
            if (diffTime < takeProfitObject.delayMinutes * 60) {
                functions.logger.log(params, `\u{1F6AB}  delayMinutes ${takeProfitObject.delayMinutes} 분을 초과하지 않아 익절을 할 수 없다. `);
                return [false,telegramMsg];
            }
        }

        // 익절 카운트가 파라미터 익절배열의 사이즈 이상이면 종료한다.
        if (data.takeProfitCount >= takeProfitObject.amtPercents.length) {
            functions.logger.log(params, `\u{1F6AB}  ${takeProfitObject.amtPercents.length}회 이상 익절 불가`);
            return [false,telegramMsg];
        }

        // 익절카운트 값을 올린다. 
        const tmpList = [...takeProfitObject.amtPercents];
        const takeProfitList = (data.safeRatio < 1) ? tmpList.reverse() : tmpList;
        const percent = takeProfitList[data.takeProfitCount];

        // 파라미터 익절값이 0이면 익절은 하지 않고 종료한다. 
        if (0 === percent) {
            functions.logger.log(params, `\u{1F6AB}  0 퍼센트 익절은 실제 익절이 일어나지는 않는다.`);
            return [false,telegramMsg];
        }

        // 익절
        const orderSide = (data.side === 'buy') ? 'sell' : 'buy';
        const profitAmt = this.getOriginAmtByTakeprofit({
            currentAmt: Math.abs(myPosition.positionAmt),
            currentIndex: data.takeProfitCount, amtPercents: takeProfitList
        });
        functions.logger.log(params, '익절수량', profitAmt, '익절배열', takeProfitList);

        if (isDebug) {
            functions.logger.log(`현재는 debug 중 입니다. takeProfit : `, { symbol, market: 'market', orderSide, profitAmt, undefined, options: { 'type': 'future' } });
            return [true,telegramMsg];
        }

        try {

            const result = await this.getExchange().createOrder(symbol, 'market', orderSide, profitAmt, undefined, { 'type': 'future' });

            functions.logger.log(`\u{1F44C} 익절 result`, result);

            /* 텔레그램 메세지
            롱익절
            size : 0.0011 BTC
            */
            const amountStr = String(Math.round(profitAmt*100)/100.0).replace(/\./g, "\\.");
            const amountUSDT = String(Math.round(profitAmt*lastPrice*100)/100.0).replace(/\./g, "\\.");
            const price = String(Math.round(result.price*100)/100.0).replace(/\./g, "\\.");
            telegramMsg = `
${side==='sell'? "\u{1F534}숏" :"\u{1F535}롱"} 익절
Price : ${price} 
Size : ${amountStr} BTC \\(${amountUSDT} USDT\\) \u{1F4B0}
`;

            // #30 익절 시에는 추매 카운트를 초기화 한다. 
            await positionRef.update({ takeProfitCount: data.takeProfitCount + 1, addCount: 0, addType: 'e' });
            // 거래 기록
            await positionRef.collection('histories').add({
                ...result.info,
                historyType: '익절'
            });

        } catch (e) {
            if (e instanceof ccxt.NetworkError) {
                functions.logger.log ('익절 failed due to a network error:', e.message);
                this.sendErrorMessage(`\u{26A0} ${this.nickName}님 익절 NetWork Error : ${e.message} \u{26A0}`);

            } else if (e instanceof ccxt.ExchangeError) {
                functions.logger.log ('익절 failed due to exchange error:', e.message);
                this.sendErrorMessage(`\u{26A0} ${this.nickName}님 익절 Exchange Error : ${e.message} \u{26A0}`);

            } else {
                functions.logger.log ('익절 failed with:', this.getErrorMessage(e));
                this.sendErrorMessage(`\u{26A0} ${this.nickName}님 익절 Error :  ${this.getErrorMessage(e)} \u{26A0}`);
                // retry or whatever
            }
            
            return [false,`익절 에러 관리자문의  \u{26A0}`];
        } 

        return [true,telegramMsg];
    }

    /**
     * 스탑로스 
     * @param symbol 
     * @param positionRef myPositions의 참조
     * @param priceString 가격의 문자열
     * @param pricePercent 진입가의 퍼센트
     * @param pricePercents 진입가의 퍼센트 배열
     * @param priceNumber 진입가
     * @param pricePercentByTele 텔레그램 매뉴얼 액션으로 스탑로스 변경시 마지막 진입가 기준으로 설정한다.
     * @returns 
     */
    async stopLoss (
        symbol: string,
        positionRef: firestore.DocumentReference,
        priceString: string | undefined,
        pricePercent: number | undefined,
        pricePercents: number[] | undefined,
        priceNumber: number | undefined,
        pricePercentByTele: number | undefined,
        isDebug: boolean = false
    ): Promise<any> {
        // firestore에 있는 내 포지션 정보를 가져와서 평단가를 가져온다. 
        const docRef = await positionRef.get();
        let telegramMsg : string = '';

        // 포지션이 없으면 익절을 할수 없다. 
        if (!docRef.exists) {
            functions.logger.log(`\u{1F6AB} 포지션이 없어서 스탑리밋을 걸수 없다1.`);
            return [false,telegramMsg];
        }
        const data = docRef.data();
        if (!data) {
            functions.logger.log(`\u{1F6AB} 포지션이 없어서 스탑리밋을 걸수 없다2.`);
            return [false,telegramMsg];
        }
        // 축소모드 
        const safeRatio = data.safeRatio;

        // 수량이 남아 있다면 스탑로스
        const afterPosition = await this.myPosition(symbol);
        // functions.logger.log('position info', afterPosition);

        // 현재 거래소에 남아 있는 물량
        const absPositionAmt = Math.abs(afterPosition.positionAmt);
        if (absPositionAmt === 0) {
            functions.logger.log(`\u{1F6AB} 포지션이 없어서 스탑리밋을 걸수 없다3.`);
            return [false,telegramMsg];
        }

        let stopPrice = 0;
        // priceString의 값이 entryPrice이면 평단가를 기준으로 stopLoss를 건다. 
        if ('entryPrice' === priceString) {
            stopPrice = data.entryPrice;
        }
        // priceString의 값이 pyramidingAvePrice이면 추매평단을 stopLoss를 건다.(1분봉 ATR 매매봇 #29)
        if ('pyramidingAvePrice' === priceString) {
            stopPrice = data.pyramidingAvePrice;
        }
        // pricePercent는 lastOrderPrice 를 기준으로 buy 포지션인 경우에는 - sell 포지션인 경우에는 + 퍼센트로 계산하여 스탑로스를 건다. 
        // 포변 / 1차 추매는 pyramidingAvePrice가 lastOrderPrice와 같다. 즉 pyramidingGap = 0 이다.(1분봉 ATR 매매봇 #29)
        // 2차 추매 sell일때 일반적으로 2차 추매 가격이 추매평단보단 위에 있다. 즉 pyramidingGap 양수가 나오고 stopLoss 계산가격에서 빼주면 stopLoss를 짧게 잡는다.
        else if (typeof pricePercent === 'number') {
            let pyramidingGap = data.pyramidingAvePrice ? data.lastOrderPrice - data.pyramidingAvePrice : 0.0; 
            stopPrice = ( data.lastOrderPrice * (1 + (pricePercent * safeRatio * 0.01)) ) - pyramidingGap;
        }
        else if (Array.isArray(pricePercents)) {
            // 익절 카운트 보다 한개 적게 해야 한다.
            let priceIndex = data.takeProfitCount - 1;
            priceIndex = (pricePercents.length < priceIndex) ? 0 : priceIndex;
            const tmpPrice = pricePercents[priceIndex] * safeRatio;
            stopPrice = data.entryPrice * (1 + (tmpPrice * 0.01));
            functions.logger.log(`\u{2139} 스탑로스정보 tmpPrice, stopPrice, safeRatio`, tmpPrice, stopPrice, safeRatio);
        }
        // 서버에서 추매진입가(평단아님)를 알수 없어서 트뷰에서 계산해서 가져온 가격을 number로 받아서 바로 넣어준다.
        else if (typeof priceNumber === 'number') {
            stopPrice = priceNumber
        }
        // 텔레그램 매뉴얼 액션으로 스탑로스 변경시 마지막 진입가 기준으로 설정한다.
        else if (typeof pricePercentByTele === 'number') {
            stopPrice = ( data.lastOrderPrice * (1 + (pricePercentByTele * safeRatio * 0.01)) );
        }
        // 스탑로스 오류
        if (stopPrice <= 0) {
            functions.logger.log(`\u{1F6AB} 스탑로스 오류`, stopPrice);
            return [false,telegramMsg];
        }

        // 기존 주문 삭제 
        if (isDebug === false) await this.exchange.cancelAllOrders(symbol);
        // functions.logger.log('기존 주문 삭제 완료');

        // 스탑로스 설정하기
        const stopLossParm: ccxt.Params = {
            'stopPrice': stopPrice,
            'workingType': 'MARK_PRICE',
            'closePosition': 'true',
            'type': 'future'
        };
        // functions.logger.log('스탑로스 파라미터', stopLossParm);

        if (isDebug) {
            functions.logger.log('현재는 debug 중 입니다. stopLoss : ', {
                symbol, market: 'STOP_MARKET', side: (afterPosition.positionAmt > 0) ? 'sell' : 'buy',
                absPositionAmt, stopLossParm
            });
            return [true,telegramMsg];
        }

        // try to call a unified method
        try {
            const result = await this.getExchange().createOrder(
                symbol, 'STOP_MARKET', (afterPosition.positionAmt > 0) ? 'sell' : 'buy',
                absPositionAmt, undefined, stopLossParm
            );
            functions.logger.log(`\u{1F44C} 스탑로스 result`,result);
            
            // 거래 기록
            await positionRef.collection('histories').add({
                ...result.info,
                historyType: '스탑로스'
            });       

            const stopPriceStr = String(Math.round(stopPrice*100)/100.0).replace(/\./g, "\\.");
            telegramMsg = `스탑로스 : ${stopPriceStr}  \u{2705}`

        } catch (e) {
            if (e instanceof ccxt.NetworkError) {
                functions.logger.log ('STOP_MARKET failed due to a network error:', e.message);
                this.sendErrorMessage(`\u{26A0} ${this.nickName}님 StopLoss NetWork Error : ${e.message} \u{26A0}`);

            } else if (e instanceof ccxt.ExchangeError) {
                functions.logger.log ('STOP_MARKET failed due to exchange error:', e.message);
                this.sendErrorMessage(`\u{26A0} ${this.nickName}님 StopLoss Exchange Error : ${e.message} \u{26A0}`);

            } else {
                functions.logger.log ('STOP_MARKET failed with:', this.getErrorMessage(e));
                this.sendErrorMessage(`\u{26A0} ${this.nickName}님 StopLoss Error :  ${this.getErrorMessage(e)} \u{26A0}`);
                // retry or whatever
            }

            return [false,`스탑로스 에러 관리자문의  \u{26A0}`];
        } 


        return [true,telegramMsg];
    }

    /**
     * 선물거래 포지션 종료 
     * 청산의 경우에는 buy 던 sell 이던 상관없다. 
     * @param symbol      
     */
    async closeBinanceFuture (symbol: string,
        positionRef: firestore.DocumentReference | undefined = undefined,
        isDebug: boolean = false): Promise<any> {
        // 해당 symbol에 진행중인 포지션이 있다면 포지션을 정리한다.         
        let myPosition = await this.myPosition(symbol);
        
        if (Math.abs(myPosition.positionAmt) > 0) {
            const side = (myPosition.positionAmt > 0) ? 'sell' : 'buy';

            if (isDebug) {
                functions.logger.log(`현재는 debug 중 입니다. 선물거래 포지션 종료 : `, {
                    symbol, market: 'market', side, positionAmt: Math.abs(myPosition.positionAmt),
                    options: { 'type': 'future' }
                });
                return [true,''];
            }

            try {
                const result = await this.getExchange().createOrder(
                    symbol, 'market', side, Math.abs(myPosition.positionAmt),
                    undefined, { 'type': 'future' });

                
                // 로그 출력
                functions.logger.log(`\u{1F44C} 포지션종료 result`, result);


                // 거래 기록
                if (positionRef) {
                    await positionRef.collection('histories').add({
                        ...result.info,
                        historyType: '포지션종료'
                    });
                }
            } catch (e) {
                if (e instanceof ccxt.NetworkError) {
                    functions.logger.log ('포지션종료 failed due to a network error:', e.message);
                    this.sendErrorMessage(`\u{26A0} ${this.nickName}님 포지션종료 NetWork Error : ${e.message} \u{26A0}`);
    
                } else if (e instanceof ccxt.ExchangeError) {
                    functions.logger.log ('포지션종료 failed due to exchange error:', e.message);
                    this.sendErrorMessage(`\u{26A0} ${this.nickName}님 포지션종료 Exchange Error : ${e.message} \u{26A0}`);
    
                } else {
                    functions.logger.log ('포지션종료 failed with:', this.getErrorMessage(e));
                    this.sendErrorMessage(`\u{26A0} ${this.nickName}님 포지션종료 Error :  ${this.getErrorMessage(e)} \u{26A0}`);
                    // retry or whatever
                }
                
                return [false,`포지션종료 에러 관리자문의  \u{26A0}`];
            } 
        }

        return [true,`포지션 종료 \u{1F62D}\u{1F62D}`];
    }

    /**
     * 선물 거래 
     * @param symbol 
     * @param side 
     */
    async createBinanceFuture (param: {
        symbol: string, side: 'buy' | 'sell', leverage: number,
        safeRatio: number, addRate: number, addType: 'e' | 'f' | 's', pyramidingType: 'ex' | 'se',
        positionRef: firestore.DocumentReference | undefined,
        cid: string, addTakeProfitCount: number, isOnce: boolean
    }, isDebug: boolean = false): Promise<any> {
        const { symbol, side, leverage, safeRatio, positionRef, cid, addRate, addType, pyramidingType, isOnce } = param;
        // 해당 symbol에 진행중인 포지션이 있다면 포지션을 정리한다. 
        const ex = this.exchange;
        const symObj = this.parseSymbol(symbol);
        let balance = await ex.fetchBalance();
        const positionData = await positionRef?.get();

        // switchZone 사용 안함.
        // let newAddRate = (zoneName && positionData?.exists && positionData.data()?.switchZone && positionData.data()?.switchZone?.addRate) ?
        //     parseFloat(positionData.data()?.switchZone?.addRate) :
        //     addRate;

        // 파이어베이스 포지션설정으로 유저별 1회성 강제 물량 설정 
        let newAddRate = (positionData?.exists && positionData.data()?.forceRate && positionData.data()?.forceRate > 0) ? 
                parseFloat(positionData.data()?.forceRate) :
                addRate;
        let newPyramidingCount = 1; // 추매 카운트 (1분봉 ATR 매매봇 #29)
        let newPyramidingAvePrice = 0.0 // 추매 평단(1분봉 ATR 매매봇 #29)
        let telegramMsg : string = '';

        // 추매 유효성 체크
        if (addType !== 'e' && positionData?.exists) {
            const pData = positionData.data();
            if (pData) {
                if (pData.side !== side) {
                    functions.logger.log(`\u{1F6AB} 추매조건 : 이전side(${pData.side})와 현재 side(${side})가 일치하지 않습니다. `);
                    return [false,telegramMsg];
                }
                // 포지션이 있고 기존 addType이 f이고 요청한 addType이 f이면 2차 추매임.(1분봉 ATR 매매봇 #29)
                const positions = balance.info.positions || [];
                const myPosition = positions.filter((p: any) => p.symbol === symObj.futureName).pop();
                if (parseFloat(myPosition.positionAmt) !== 0){
                    // 기존추매(이평/거래량/볼밴/스톡케스틱)는 2번까지만 추매 가능, 이격추매는 4번까지 가능 
                    if (addType === 'f' && pData.addType === 'f') {
                        if (pData.pyramidingCount >= 2 && pyramidingType === 'ex'){
                            functions.logger.log(`\u{1F6AB} 추매는 연속 2번까지만 가능합니다.`);
                            return [false,telegramMsg];
                        }else if (pData.pyramidingCount >= 4 && pyramidingType === 'se'){
                            functions.logger.log(`\u{1F6AB} 이격추매는 연속 4번까지만 가능합니다.`);
                            return [false,telegramMsg];
                        }
                        newPyramidingAvePrice = (pData.pyramidingAvePrice && pyramidingType === 'ex') ? pData.pyramidingAvePrice : pData.lastOrderPrice
                        newPyramidingCount = (pData.pyramidingCount) ? pData.pyramidingCount + 1 : 1;
                    }
                }
            }
        }

        // 잔금이 있으면 order 를 한다. 
        // balance = await ex.fetchBalance();
        const bidAsk = await ex.fetchBidsAsks([symbol], { 'type': 'future' });
        // 주문물량이 100%일땐 거래가 실패 될수 있기 때문에 99%로 1%버퍼를 둔다. 
        const freeAmt = newAddRate < 1 ? balance[symObj.currency].free : balance[symObj.currency].free * this.orderAmountbufferPercent;
        if (balance[symObj.currency].free > 10) {

            const orderAmount = (freeAmt * leverage * newAddRate) / bidAsk[symbol].ask;
            // functions.logger.log(`createOrder : bidAsk(${bidAsk[symbol].ask}), symbol/${symbol}, amount/${orderAmount}, free / ${freeAmt * leverage}`);

            if (isDebug) {
                functions.logger.log(`현재는 debug 중 입니다. createOrder : `, {
                    symbol, market: 'market', side, orderAmount, optiosn: { 'type': 'future' }
                });
                return [true,telegramMsg];
            }

            try {
                const result = await this.getExchange().createOrder(symbol, 'market', side, orderAmount, undefined, { 'type': 'future' });
                functions.logger.log(`\u{1F44C} 매수 / 매도 / 추매 result`,result, `createOrder : bidAsk(${bidAsk[symbol].ask}), symbol/${symbol}, amount/${orderAmount}, free / ${freeAmt * leverage}`);

                /* 텔레그램 메세지
                숏 포지션 변경 
                Price : 29890.6 
                Size : 0.011 BTC (32.88 USDT)
                */
                const averageStr = String(Math.round(result.price*100)/100.0).replace(/\./g, "\\.");
                const amountStr = String(result.amount).replace(/\./g, "\\.");
                const costStr = String(Math.round(result.cost*100)/100.0).replace(/\./g, "\\.");
                telegramMsg = `
${side==='sell'? "\u{1F534}숏" :"\u{1F535}롱"} ${addType==='e'? "포지션 변경":"추매"} 
Price : ${averageStr} 
Size : ${amountStr} BTC \\(${costStr} USDT\\)
` ;

                let newTakeProfitCount = 0;

                // 포지션 등록
                // 거래소에서 내 포지션 정보를 가져온다.  
                const myPosition = await this.myPosition(symbol);
                await positionRef?.set({
                    nickName: this.nickName,
                    email: this.email,
                    entryPrice: parseFloat(myPosition.entryPrice),
                    lastOrderPrice: result.price,
                    pyramidingAvePrice : newPyramidingCount === 1 ? result.price : (newPyramidingAvePrice + result.price) /2,
                    leverage: parseFloat(myPosition.leverage),
                    side,
                    symbol,
                    takeProfitCount: newTakeProfitCount,
                    positionAmt: parseFloat(myPosition.positionAmt),
                    safeRatio,
                    cid,
                    addRate: newAddRate,
                    forceRate : 0,
                    addType,
                    pyramidingCount : newPyramidingCount,
                    isOnce,
                    createdAt: new Date()
                }, { merge: true });

                // 거래 기록
                await positionRef?.collection('histories').add({
                    ...result.info,
                    historyType: addType === 'e' ? '포변' : '추매'
                });

            } catch (e) {
                if (e instanceof ccxt.NetworkError) {
                    functions.logger.log (`${addType === 'e' ? '포변' : '추매'} failed due to a network error:`, e.message);
                    this.sendErrorMessage(`\u{26A0} ${this.nickName}님 ${addType === 'e' ? '포변' : '추매'} NetWork Error : ${e.message} \u{26A0}`);
    
                } else if (e instanceof ccxt.ExchangeError) {
                    functions.logger.log (`${addType === 'e' ? '포변' : '추매'} failed due to exchange error:`, e.message);
                    this.sendErrorMessage(`\u{26A0} ${this.nickName}님 ${addType === 'e' ? '포변' : '추매'}  Exchange Error : ${e.message} \u{26A0}`);
    
                } else {
                    functions.logger.log (`${addType === 'e' ? '포변' : '추매'} failed with:`, this.getErrorMessage(e));
                    this.sendErrorMessage(`\u{26A0} ${this.nickName}님 ${addType === 'e' ? '포변' : '추매'}  Error :  ${this.getErrorMessage(e)} \u{26A0}`);
                    // retry or whatever
                }
                
                return [false,`${addType === 'e' ? '포변' : '추매'} 에러 관리자문의  \u{26A0}`];
            } 

            return [true,telegramMsg];

        }

        return [false,telegramMsg];
    }

    /**
     * 텔레그램 메세지 처리
     * @param telegramMsg      
     */
     async sendTelegramMsg (telegramMsg: string,
        telegramId: string): Promise<boolean> {
        
        if (null === telegramMsg){
            return false;
        }

         // 텔레그램 메세지
         this.telegram.send(telegramId, telegramMsg, Telegram_ParseModes.MarkdownV2);
         functions.logger.log(`텔레그램 메세지 발송 완료(${telegramId})`,telegramMsg);
        return true;
    } 

    /**
     * 바이낸스 서버에서 유저 발란스를 가져온다.
     * @returns userBalance
     */

    async getBalance (userSeed : number): Promise<string> {

        const ex = this.exchange;
        try {
            let balance = await ex.fetchBalance();
            let positions = balance.info.positions || [];
            let myPosition = positions.filter((p: any) => p.symbol === 'BTCUSDT').pop();
            let assets = balance.info.assets || [];
            let myAsset = assets.filter((p: any) => p.asset === 'USDT').pop();


            functions.logger.log(`닉네이 시드 레버레지 남은물량 포지션물량 PNL 지갑잔금 잔금 수익률\r\n${this.nickName} ${userSeed} ${myPosition.leverage} ${Math.round(myAsset.availableBalance*100)/100.0} ${Math.round(myPosition.positionInitialMargin*100)/100.0} ${Math.round(myPosition.unrealizedProfit*100)/100.0} ${Math.round(myAsset.walletBalance*100)/100.0} ${Math.round(myAsset.marginBalance*100)/100.0} ${Math.round(((myAsset.marginBalance-userSeed)/(userSeed/100))*100)/100.0}%\r\n`);
            const userBalance : string = `${this.nickName} ${userSeed} ${Math.round(myPosition.unrealizedProfit*100)/100.0} ${Math.round(myAsset.marginBalance*100)/100.0} ${Math.round(((myAsset.marginBalance-userSeed)/(userSeed/100))*100)/100.0}%\r\n`;
        
            return userBalance;

        } catch (e) {
            if (e instanceof ccxt.NetworkError) {
                functions.logger.log ('유저 발란스 failed due to a network error:', e.message);
                this.sendErrorMessage(`\u{26A0} ${this.nickName}님 발란스 NetWork Error : ${e.message} \u{26A0}`);

            } else if (e instanceof ccxt.ExchangeError) {
                functions.logger.log ('유저 발란스 failed due to exchange error:', e.message);
                this.sendErrorMessage(`\u{26A0} ${this.nickName}님 발란스 Exchange Error : ${e.message} \u{26A0}`);

            } else {
                functions.logger.log ('유저 발란스 failed with:', this.getErrorMessage(e));
                this.sendErrorMessage(`\u{26A0} ${this.nickName}님 발란스 Error :  ${this.getErrorMessage(e)} \u{26A0}`);
                // retry or whatever
            }

            return `${this.nickName} 발란스 에러`;
        } 
    }

    /**
     * 유저 계좌 정보
     * @param usersBalance      
     */
     async sendUserBalance (usersBalance: string): Promise<boolean> {
        const telegramReport = new Telegram('5165765010:AAGX6t4dC1FdE03uwLEhTp1wkVeo10UTMhY');
        if (null === usersBalance){
            return false;
        }
        usersBalance = `\u{1F4CA} Daily Report \r\n닉네임 원금 PNL 잔금 수익률\r\n${usersBalance}`;
        // 텔레그램 메세지
        telegramReport.send('48717538', usersBalance.replace(/\-/g, "\\-").replace(/\./g, "\\."), Telegram_ParseModes.MarkdownV2);
        // functions.logger.log(usersBalance);
        return true;
    } 
    

    /**
     * 텔레그램 메세지 테스트 
     * @param telegramId 
     * @returns 
     */
    async telegramMsgTest (symbol: string): Promise<any> {
        
        // let telMsg : string = `${telegramId} 포변 추매 \u{1F680}\u{1F60D}\u{1F308}\u{1F4B9}`
// 익절 \u{1F4B0}\u{1F4B5}\u{1F37A}\u{1F357}
// 스탑로스 \u{1F64F}\u{1F64F}\u{1F64F}\u{1F64F}
// 로스컷 \u{1F62D}\u{1F4A9}\u{1F62D}\u{1F4A9}`

         // 텔레그램 메세지
        //  this.telegram.send(telegramId, telMsg, Telegram_ParseModes.MarkdownV2);

        // const myPosition = await this.myPosition(symbol);
        // functions.logger.log('myPosition info', myPosition);
        // const ex = this.exchange;
        // const symObj = this.parseSymbol(symbol);
        // 거래소에서 내 포지션 정보를 가져온다.  

        // const leverage : number = 10;
        const myPosition = await this.myPosition(symbol);
        functions.logger.log('myPosition info', myPosition);

        // 거래소에서 현재가를 가져온다.
        let tiker = await this.getExchange().fetchTicker(symbol, { 'type': 'future' });

        functions.logger.log(`\u{1F6AB} 그룹 테스트 ${this.nickName} `, myPosition, tiker);


        // // 이익이 -2%까지 감수한다.
        // const limitTakeProfitPrice : number = Math.abs(((parseFloat(myPosition.entryPrice) - parseFloat(tiker.info.lastPrice)) / parseFloat(tiker.info.lastPrice) ) * 100 * leverage);
        // // 이익이 음수이면 종료한다. 포지션을 가지고 있지 않으면 0일 것이다.
        // if (limitTakeProfitPrice < -2) {
        //     functions.logger.log(`\u{1F6AB} 이익이 없으면 익절을 할수 없다1. ${limitTakeProfitPrice} ${tiker.info.lastPrice} ${myPosition.entryPrice}`);
        // }else{
        //     functions.logger.log(`\u{1F6AB} 이익이 없으면 익절을 할수 없다2.${limitTakeProfitPrice} ${tiker.info.lastPrice} ${myPosition.entryPrice}`);
        // }

        return true;
    }

}